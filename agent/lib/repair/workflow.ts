import { type WorkflowToolContext } from 'eve/tools'
import { candidateSchema } from './candidate'
import { sanitizeText } from '../redaction'
import {
  claimScope,
  releaseScope,
  loadWork,
  record,
  recordFailure,
  recordOutcome
} from './state'
import { investigate } from './investigation'
import {
  beginVerification,
  verify,
  cleanup,
  type Verification,
  type VerificationProgress
} from './verification'

import { waitForActiveWork } from './wait'
import { publish } from './publication'
import {
  candidateReportContext,
  carryReport,
  isGatewayBudgetFailure,
  withOptionalVercelUncertainty,
  type CandidateReportContext
} from './policy'

export async function runRepair(
  _input: Record<string, never>,
  ctx: WorkflowToolContext
) {
  'use workflow'
  const scope = await claimScope(ctx.session.auth.current, ctx.callId)
  if (!scope) return { status: 'disabled-or-busy' }
  try {
    const work = await loadWork(scope)
    if (!work) return { status: 'idle' }
    const { repoId, evidence, deadline, blockers } = work
    let job = work.job
    let feedback: string | undefined
    for (let attempt = job.marker.attempts; attempt < 2; attempt++) {
      job = carryReport(job, await record(repoId, job, attempt + 1))
      let context: CandidateReportContext | undefined
      let verification: Verification | undefined
      let stoppedReason: string | undefined
      try {
        const investigation = await investigate(ctx, work, job, attempt, feedback)
        job = investigation.job
        if (investigation.kind === 'stopped')
          return { status: 'reported', reason: investigation.reason }
        if (investigation.kind === 'failed') throw investigation.error
        if (investigation.kind === 'timeout') {
          await recordFailure(
            repoId,
            job,
            'Investigation exceeded 30 minutes',
            attempt + 1
          )
          return { status: 'reported' }
        }
        const outcome = investigation.value
        if (outcome.status === 'failed') {
          const message = outcome.error?.message ?? 'Coding agent failed'
          const budget = isGatewayBudgetFailure(outcome.error)
          await recordFailure(repoId, job, message, attempt + 1, budget)
          return {
            status: budget ? 'budget-paused' : 'reported',
            reason: sanitizeText(message)
          }
        }
        const data = outcome.data
        if (!data)
          throw new Error(
            'Investigation completed without structured RCA output'
          )
        context = candidateReportContext(data)
        const reportOnly = [
          ...blockers,
          ...(data.blocker ? [data.blocker] : []),
          ...(data.rootCause.confidence === 'undetermined'
            ? ['The evidence does not identify a causal code defect.']
            : [])
        ]
        if (reportOnly.length) {
          await recordFailure(
            repoId,
            job,
            reportOnly.join('\n'),
            attempt + 1,
            false,
            context
          )
          return {
            status: 'reported',
            reason:
              'Investigation report saved; repair requirements remain unmet.'
          }
        }
        const candidate = candidateSchema.parse(data)
        const started = await beginVerification(
          repoId,
          job,
          candidate,
          evidence.details.vercel.deployments,
          deadline
        )
        const progress: VerificationProgress = {
          commands: [...started.commands]
        }
        try {
          const result = await waitForActiveWork(
            verify(repoId, started.name, candidate, deadline, progress),
            repoId,
            job,
            attempt + 1,
            deadline,
            deadline
          )
          job = result.job
          if (result.kind === 'stopped') {
            stoppedReason = result.reason
            return { status: 'reported', reason: result.reason }
          }
          if (result.kind === 'failed') throw result.error
          verification = withOptionalVercelUncertainty<Verification>(
            result.kind === 'timeout'
              ? {
                  status: 'blocked',
                  summary:
                    'Persisted incident execution deadline reached during verification; only completed command results are recorded.',
                  commands: [...progress.commands],
                  ...(progress.regression
                    ? { regression: progress.regression }
                    : {}),
                  files: []
                }
              : result.value,
            evidence.details.vercel
          )
        } finally {
          await cleanup(started.name)
        }
        if (verification.status !== 'passed') {
          job = carryReport(
            job,
            await recordOutcome(
              repoId,
              job,
              candidate,
              verification,
              attempt + 1
            )
          )
          feedback = JSON.stringify({
            summary: verification.summary,
            commands: verification.commands
          }).slice(-16_000)
          if (attempt === 0) continue
          return { status: 'reported', reason: verification.summary }
        }
        const publication = await publish(
          repoId,
          job,
          candidate,
          verification,
          attempt + 1,
          evidence.details.vercel.deployments,
          deadline
        )
        if (publication.status === 'publication-failed') {
          job = publication.job
          await recordFailure(
            repoId,
            job,
            publication.reason,
            attempt + 1,
            false,
            context,
            verification
          )
          return { status: 'reported', reason: publication.reason }
        }
        return publication
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Incident repair failed'
        // A refresh already wrote safe new-release/unavailable state. A
        // cleanup failure must not replace it with the old candidate's RCA.
        if (stoppedReason)
          return {
            status: 'reported',
            reason: `${stoppedReason} ${sanitizeText(message)}`
          }
        const budget = isGatewayBudgetFailure(error)
        await recordFailure(
          repoId,
          job,
          message,
          attempt + 1,
          budget,
          context,
          verification
        )
        return {
          status: budget ? 'budget-paused' : 'reported',
          reason: sanitizeText(message)
        }
      }
    }
    return { status: 'reported' }
  } finally {
    await releaseScope(scope, ctx.callId)
  }
}
