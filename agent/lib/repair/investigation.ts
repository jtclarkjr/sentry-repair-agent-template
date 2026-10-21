import { z } from 'zod'
import { type WorkflowToolContext } from 'eve/tools'
import { candidateSchema } from './candidate'
import { type QueuedIncident } from '../incidents/queue'
import { type loadWork } from './state'
import { remainingTime, stageDeadline, waitForActiveWork } from './wait'

// Reports may lack a regression; executable candidates must pass candidateSchema.
const investigationSchema = candidateSchema.extend({
  expectedFailure: z.string().max(200)
})

export async function investigate(
  ctx: WorkflowToolContext,
  work: NonNullable<Awaited<ReturnType<typeof loadWork>>>,
  job: QueuedIncident,
  attempt: number,
  feedback?: string
) {
  const { repoId, evidence, deadline, blockers } = work
  const remaining = await remainingTime(deadline)
  if (remaining < 1000)
    throw new Error('Incident execution deadline reached')
  const investigationDeadline = await stageDeadline(deadline, 1_800_000)
  const response = await ctx.agent('fixer').send(
    JSON.stringify({
      ...evidence,
      incident: job.incident,
      marker: job.marker,
      report: job.report,
      previousAttempt: attempt,
      previousVerification: feedback,
      rolloutBlockers: blockers,
      requirements: blockers.length
        ? 'Investigate and return a report-only RCA with an honest blocker. Repair is disabled until the supplied rollout blockers are resolved. Return empty patches and expectedFailure. No publishing.'
        : 'Return a candidate or an honest report-only blocker. No publishing.'
    }),
    { outputSchema: investigationSchema, signal: ctx.abortSignal }
  )
  return waitForActiveWork(
    response.result(),
    repoId,
    job,
    attempt + 1,
    investigationDeadline,
    deadline
  )
}
