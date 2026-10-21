import { acquireLease, releaseLease } from '../github/lease'
import { getRepository as repository } from '../registry'
import { type QueuedIncident } from '../incidents/queue'
import { type Candidate } from './candidate'
import { type Verification } from './verification'
import {
  blockedVerification,
  recordedAttempts,
  candidateReportContext,
  unverifiedFlows,
  repairBlockers,
  type CandidateReportContext
} from './policy'

export async function claimScope(auth: unknown, owner: string) {
  'use step'
  const { monitoringEnabled, authorizedRepository } = await import('../incidents/intake')
  if (!monitoringEnabled()) return null
  const repo = authorizedRepository(auth)
  const { createGitHubClient } = await import('../github/client')
  const gh = createGitHubClient()
  const info = await gh.request<any>(
    repo,
    'GET',
    `/repos/${repo.owner}/${repo.repo}`
  )
  const branch = await gh.request<any>(
    repo,
    'GET',
    `/repos/${repo.owner}/${repo.repo}/branches/${encodeURIComponent(info.default_branch)}`
  )
  return (await acquireLease(gh, repo, owner, branch.commit.sha))
    ? repo.id
    : null
}
export async function releaseScope(repoId: string, owner: string) {
  'use step'
  const { createGitHubClient } = await import('../github/client')
  await releaseLease(createGitHubClient(), repository(repoId), owner)
}
export async function loadWork(repoId: string) {
  'use step'
  const { monitoringEnabled } = await import('../incidents/intake')
  const { prepareQueue, evidenceForFixer } = await import('../incidents/queue')
  if (!monitoringEnabled()) return null
  const repo = repository(repoId)
  const [job] = await prepareQueue(repo)
  if (!job) return null
  const deadline = job.marker.executionDeadline
    ? Date.parse(job.marker.executionDeadline)
    : Date.now() + 3_600_000
  if (deadline <= Date.now()) {
    const { updateReport } = await import('../incidents/queue')
    await updateReport(repo, job, {
      status: 'reported',
      attempts: 2,
      verification: {
        status: 'blocked',
        summary:
          'Persisted incident execution deadline reached after interruption'
      }
    })
    return null
  }
  job.marker.executionDeadline = new Date(deadline).toISOString()
  const evidence = await evidenceForFixer(repo, job)
  return {
    repoId: repo.id,
    job,
    evidence,
    deadline,
    blockers: repairBlockers(
      repo,
      job.incident,
      job.baseSha,
      evidence.details.vercel.deployments
    )
  }
}
export async function record(repoId: string, job: QueuedIncident, attempts: number) {
  'use step'
  const { updateReport } = await import('../incidents/queue')
  return updateReport(repository(repoId), job, {
    status: 'investigating',
    attempts
  })
}
export async function recordFailure(
  repoId: string,
  job: QueuedIncident,
  message: string,
  attempts: number,
  budget = false,
  context?: CandidateReportContext,
  verification?: Verification
) {
  'use step'
  const { updateReport } = await import('../incidents/queue')
  return updateReport(repository(repoId), job, {
    status: budget ? 'budget-paused' : 'reported',
    attempts: recordedAttempts(attempts, budget),
    ...(context
      ? { rootCause: context.rootCause, flows: unverifiedFlows(context) }
      : {}),
    verification: blockedVerification(message, verification)
  })
}
export async function recordOutcome(
  repoId: string,
  job: QueuedIncident,
  candidate: Candidate,
  verification: Verification,
  attempts: number
) {
  'use step'
  const { updateReport } = await import('../incidents/queue')
  const context = candidateReportContext(candidate)!
  return updateReport(repository(repoId), job, {
    status: 'reported',
    attempts,
    flows: unverifiedFlows(context),
    rootCause: context.rootCause,
    verification
  })
}
