import { type QueuedIncident, type updateReport } from './queue'
import { type inspectSentryIssue } from '../telemetry/sentry-issues'
import { type RepositoryConfig } from '../registry'
import { carryReport } from '../repair/policy'

type Inspection = Awaited<ReturnType<typeof inspectSentryIssue>>
type ReportUpdate = Parameters<typeof updateReport>[2]
export type ActiveIncidentState = 'current' | 'changed' | 'unavailable'
export type ActiveIncident = {
  job: QueuedIncident
  state: ActiveIncidentState
  reason?: string
}

export function planActiveRefresh(
  repo: RepositoryConfig,
  job: QueuedIncident,
  inspection: Inspection,
  attempts: number
): ActiveIncident & { update: ReportUpdate } {
  const details = inspection.details
  const releaseSha = details?.release.sha
  const lastSeen =
    details && Date.parse(details.timestamp) > Date.parse(job.incident.lastSeen)
      ? details.timestamp
      : job.incident.lastSeen
  const refreshed: QueuedIncident = {
    ...job,
    incident: { ...inspection.incident, lastSeen },
    marker: { ...job.marker, lastSeen },
    details: { sentry: details, limitations: inspection.errors }
  }
  if (
    !details ||
    !repo.environments.includes(details.environment ?? '') ||
    !/^[a-f0-9]{40}$/.test(releaseSha ?? '')
  ) {
    const reason =
      'The latest production release could not be verified; repair stopped until safe Sentry evidence is available.'
    return {
      job: refreshed,
      state: 'unavailable',
      reason,
      update: {
        status: 'reported',
        attempts,
        verification: {
          status: 'evidence-unavailable',
          summary: `${reason} ${inspection.errors.join('; ')}`
        }
      }
    }
  }
  if (
    releaseSha !== job.incident.releaseSha ||
    releaseSha !== job.marker.releaseKey
  ) {
    const reason =
      'The production Sentry release changed during investigation. The old repair stopped; the new release requires fresh triage.'
    refreshed.incident.releaseSha = releaseSha
    const {
      prUrl: _pr,
      executionDeadline: _deadline,
      pausedUntil: _pause,
      assessment: _assessment,
      verification: _verification,
      ...marker
    } = refreshed.marker
    refreshed.marker = {
      ...marker,
      releaseKey: releaseSha!,
      attempts: 0,
      priority: 'P2',
      flows: [],
      rootCause: undefined
    }
    return {
      job: refreshed,
      state: 'changed',
      reason,
      update: {
        status: 'queued',
        attempts: 0,
        flows: [],
        rootCause: {
          confidence: 'undetermined',
          summary: 'A new production release needs independent investigation.',
          evidence: [],
          unknowns: [
            "The earlier release investigation does not establish this release's root cause or flow impact."
          ]
        },
        verification: { status: 'pending', summary: reason }
      }
    }
  }
  refreshed.incident.releaseSha = releaseSha
  return {
    job: refreshed,
    state: 'current',
    update: { status: 'investigating', attempts }
  }
}

export async function refreshActiveIncident(
  repo: RepositoryConfig,
  job: QueuedIncident,
  attempts: number,
  deadline: number,
  ports?: { inspect: typeof inspectSentryIssue; update: typeof updateReport }
): Promise<ActiveIncident> {
  const adapters = ports ?? {
    inspect: (await import('../telemetry/sentry-issues')).inspectSentryIssue,
    update: (await import('./queue')).updateReport
  }
  const inspection = await adapters.inspect(repo, job.incident, {
    deadline: Math.min(deadline, Date.now() + 45_000)
  })
  const plan = planActiveRefresh(repo, job, inspection, attempts)
  const result = await adapters.update(repo, plan.job, plan.update)
  return {
    job: carryReport(plan.job, result),
    state: plan.state,
    ...(plan.reason ? { reason: plan.reason } : {})
  }
}
