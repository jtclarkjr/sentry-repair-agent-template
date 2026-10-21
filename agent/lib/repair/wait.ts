import { sleep } from 'workflow'
import { type QueuedIncident } from '../incidents/queue'
import { getRepository as repository } from '../registry'
import { activeWaitDelay } from './policy'

type ActiveWaitResult<T> = { job: QueuedIncident } & (
  | { kind: 'complete'; value: T }
  | { kind: 'failed'; error: unknown }
  | { kind: 'stopped'; reason: string }
  | { kind: 'timeout' }
)
// Ordinary helpers execute in the owning workflow realm. They do not pass
// Promise objects across a step/workflow serialization boundary.
export async function waitForActiveWork<T>(
  pending: Promise<T>,
  repoId: string,
  job: QueuedIncident,
  attempts: number,
  stageEnd: number,
  overallEnd: number
): Promise<ActiveWaitResult<T>> {
  const settled = pending.then(
    (value) => ({ kind: 'complete' as const, value }),
    (error) => ({ kind: 'failed' as const, error })
  )
  for (;;) {
    const remaining = await remainingTime(Math.min(stageEnd, overallEnd))
    if (remaining <= 0) return { kind: 'timeout', job }
    const result = await Promise.race([
      settled,
      sleep(activeWaitDelay(remaining)).then(() => ({ kind: 'tick' as const }))
    ])
    if (result.kind !== 'tick') return { ...result, job }
    if ((await remainingTime(Math.min(stageEnd, overallEnd))) <= 0)
      return { kind: 'timeout', job }
    try {
      const refreshed = await refresh(repoId, job, attempts, overallEnd)
      job = refreshed.job
      if (refreshed.state !== 'current')
        return {
          kind: 'stopped',
          job,
          reason: refreshed.reason ?? 'Fresh production evidence is unavailable'
        }
    } catch (error) {
      return { kind: 'failed', error, job }
    }
  }
}
export async function stageDeadline(overall: number, duration: number) {
  'use step'
  return Math.min(overall, Date.now() + duration)
}
async function refresh(
  repoId: string,
  job: QueuedIncident,
  attempts: number,
  deadline: number
) {
  'use step'
  const { refreshActiveIncident } = await import('../incidents/active-incident')
  return refreshActiveIncident(repository(repoId), job, attempts, deadline)
}
export async function remainingTime(deadline: number) {
  'use step'
  return Math.max(0, deadline - Date.now())
}
