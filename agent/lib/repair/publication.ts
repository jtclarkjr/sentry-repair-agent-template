import { publish as publishFix } from '../github/publish'
import { type Candidate } from './candidate'
import { type Verification } from './verification'
import { type QueuedIncident } from '../incidents/queue'
import { type FlowAssessment } from '../incidents/model'
import { getRepository as repository } from '../registry'
import { sanitizeText } from '../redaction'
import { repairBlockers, carryReport } from './policy'

function locallyVerifiedFlows(
  candidate: Candidate,
  verified = true
): FlowAssessment[] {
  return candidate.flows.map((flow) => ({
    ...flow,
    impact: !verified || flow.impact === 'unaffected' ? 'unknown' : flow.impact,
    confidence: verified ? 'probable' : 'unknown',
    systemWide: false,
    dataLoss: false,
    evidence: [
      ...flow.evidence,
      verified
        ? 'Impact is inferred from the causal regression and production event; total production scope and recovery remain unverified.'
        : 'Verification is incomplete; flow impact remains unknown.'
    ]
  }))
}
export async function publish(
  repoId: string,
  job: QueuedIncident,
  candidate: Candidate,
  verification: Verification,
  attempts: number,
  deployments: { state: string | null; sha: string | null }[],
  deadline: number
) {
  'use step'
  const { updateReport } = await import('../incidents/queue')
  const { createGitHubClient } = await import('../github/client')
  const { refreshActiveIncident } = await import('../incidents/active-incident')
  const repo = repository(repoId)
  // Recheck inside the publication step so retries never reuse a memoized
  // release observation from an earlier workflow step.
  const current = await refreshActiveIncident(repo, job, attempts, deadline)
  if (current.state !== 'current')
    return { status: 'reported' as const, reason: current.reason }
  job = current.job
  try {
    const blockers = repairBlockers(
      repo,
      job.incident,
      job.baseSha,
      deployments
    )
    if (blockers.length) throw new Error(blockers.join('\n'))
    if (Date.now() >= deadline)
      throw new Error('Incident execution deadline reached before publication')
    if (
      verification.status !== 'passed' ||
      verification.regression?.after !== 0 ||
      !verification.regression.before ||
      !verification.files.length
    )
      throw new Error('Trusted verification required before publication')
    const rootCause =
      candidate.rootCause.confidence === 'undetermined'
        ? candidate.rootCause
        : { ...candidate.rootCause, confidence: 'confirmed' as const }
    const result = await updateReport(repo, job, {
      status: 'verified',
      attempts,
      flows: locallyVerifiedFlows(candidate),
      rootCause,
      verification
    })
    job = carryReport(job, result)
    const pr = await publishFix(
      createGitHubClient(),
      repo,
      job.incident.issueId,
      job.baseSha,
      verification.files,
      `[${result.marker.priority}] Fix ${job.incident.title}`,
      result.body
    )
    await updateReport(repo, job, {
      status: 'pr-open',
      attempts,
      flows: locallyVerifiedFlows(candidate),
      rootCause,
      verification,
      prUrl: pr.url
    })
    return { status: 'pr-open' as const, url: pr.url }
  } catch (error) {
    return {
      status: 'publication-failed' as const,
      job,
      reason: sanitizeText(
        error instanceof Error ? error.message : 'Publication failed'
      )
    }
  }
}
