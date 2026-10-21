import {
  reports as listReports,
  upsertReport,
  type ReportRecord
} from '../github/reports'
import { z } from 'zod'
import { assessPriority } from './priority'
import {
  flowAssessmentSchema,
  priorityAssessmentSchema,
  rootCauseSchema,
  type IncidentEvidence,
  type FlowAssessment,
  type RootCause
} from './model'
import { sanitizeText } from '../redaction'
import { renderIncidentReport, type VerificationReport } from './report'
import { createGitHubClient } from '../github/client'
import { type IncidentMarker } from '../github/state'

import {
  inspectSentryIssue,
  pollSentryIssues
} from '../telemetry/sentry-issues'
import { collectRelatedSentryTelemetry } from '../telemetry/sentry-related'
import { collectVercelEvidence } from '../telemetry/vercel'
import { type RepositoryConfig } from '../registry'

export const unknownCause: RootCause = {
  confidence: 'undetermined',
  summary: 'Investigation pending; telemetry does not yet establish the cause.',
  evidence: [],
  unknowns: ['Root cause and flow impact have not been verified.']
}
export type QueuedIncident = {
  incident: IncidentEvidence
  marker: IncidentMarker
  report: ReportRecord
  details: unknown
  baseSha: string
}

function boundedVerification(
  value: VerificationReport | undefined
): VerificationReport | undefined {
  if (!value) return undefined
  return {
    status: sanitizeText(value.status, 100),
    summary: sanitizeText(value.summary, 1_500),
    ...(value.commands
      ? {
          commands: value.commands.slice(-6).map((command) => ({
            command: sanitizeText(command.command, 300),
            exitCode: command.exitCode,
            output: sanitizeText(command.output, 400)
          }))
        }
      : {}),
    ...(value.regression ? { regression: value.regression } : {})
  }
}

async function collectSentryIntake(repo: RepositoryConfig) {
  const deadline = Date.now() + 45_000
  let poll = await pollSentryIssues(repo, { deadline })
  const { start, end } = poll
  const incidents = new Map<string, IncidentEvidence>()
  const visited = new Set<string>()
  for (let batch = 0; batch < 100; batch++) {
    if (poll.errors.length)
      throw new Error(
        `Sentry reconciliation incomplete: ${poll.errors.join('; ')}`
      )
    for (const incident of poll.incidents)
      incidents.set(
        `${incident.org}/${incident.project}/${incident.issueId}`,
        incident
      )
    if (incidents.size > 10_000)
      throw new Error(
        'Sentry reconciliation incomplete: intake exceeds 10,000 issue groups'
      )
    if (poll.complete) return [...incidents.values()]
    if (!poll.nextCursor || visited.has(poll.nextCursor))
      throw new Error(
        'Sentry reconciliation incomplete: missing or repeated intake cursor'
      )
    if (Date.now() >= deadline)
      throw new Error(
        'Sentry reconciliation incomplete: intake deadline reached'
      )
    if (batch === 99)
      throw new Error(
        'Sentry reconciliation incomplete: intake page limit reached'
      )
    visited.add(poll.nextCursor)
    poll = await pollSentryIssues(repo, {
      start,
      end,
      cursor: poll.nextCursor,
      deadline
    })
  }
  throw new Error('Sentry reconciliation incomplete: intake page limit reached')
}

export async function hasUpdates(repo: RepositoryConfig) {
  const incidents = await collectSentryIntake(repo)
  const reports = await listReports(createGitHubClient(), repo)
  for (const incident of incidents) {
    const previous = reports.find(
      (row) => row.marker.issueId === incident.issueId
    )?.marker
    if (
      previous?.status === 'budget-paused' &&
      previous.pausedUntil &&
      Date.parse(previous.pausedUntil) > Date.now()
    )
      continue
    if (
      previous?.verification?.status === 'evidence-unavailable' &&
      previous.attempts < 2
    ) {
      const inspection = await inspectSentryIssue(repo, incident)
      if (
        inspection.details &&
        repo.environments.includes(inspection.incident.environment ?? '')
      )
        return true
      continue
    }
    if (
      !previous ||
      previous.lastSeen !== incident.lastSeen ||
      (previous.attempts < 2 &&
        ['queued', 'investigating', 'verified', 'budget-paused'].includes(
          previous.status
        ))
    )
      return true
  }
  return false
}

export async function prepareQueue(
  repo: RepositoryConfig
): Promise<QueuedIncident[]> {
  const gh = createGitHubClient()
  const incidents = await collectSentryIntake(repo)
  const previousReports = await listReports(gh, repo)
  const info = await gh.request<any>(
    repo,
    'GET',
    `/repos/${repo.owner}/${repo.repo}`
  )
  const base = await gh.request<any>(
    repo,
    'GET',
    `/repos/${repo.owner}/${repo.repo}/branches/${encodeURIComponent(info.default_branch)}`
  )
  const queued: QueuedIncident[] = []
  for (const original of incidents) {
    const previous = previousReports.find(
      (row) => row.marker.issueId === original.issueId
    )
    if (
      previous?.marker.status === 'budget-paused' &&
      previous.marker.pausedUntil &&
      Date.parse(previous.marker.pausedUntil) > Date.now()
    )
      continue
    if (
      previous?.marker.lastSeen === original.lastSeen &&
      previous.marker.verification?.status !== 'evidence-unavailable' &&
      !['queued', 'investigating', 'verified', 'budget-paused'].includes(
        previous.marker.status
      )
    )
      continue
    const inspection = await inspectSentryIssue(repo, original)
    const incident = inspection.incident
    const releaseKey =
      incident.releaseSha ??
      inspection.details?.release.version ??
      `unknown:${incident.firstSeen}`
    const sameRelease = previous?.marker.releaseKey === releaseKey
    const flows = (sameRelease ? (previous?.marker.flows ?? []) : []).flatMap(
      (flow) => {
        const parsed = flowAssessmentSchema.safeParse(flow)
        return parsed.success ? [parsed.data] : []
      }
    )
    const parsedCause = rootCauseSchema.safeParse(
      sameRelease ? previous?.marker.rootCause : undefined
    )
    const rootCause = parsedCause.success ? parsedCause.data : unknownCause
    const parsedAssessment = priorityAssessmentSchema.safeParse(
      sameRelease ? previous?.marker.assessment : undefined
    )
    const priority = assessPriority(
      incident,
      flows,
      parsedAssessment.success ? parsedAssessment.data : undefined,
      new Date(),
      repo.criticalFlows
    )
    const shouldRepair =
      !sameRelease ||
      previous?.marker.verification?.status === 'evidence-unavailable' ||
      ['queued', 'investigating', 'verified', 'budget-paused'].includes(
        previous!.marker.status
      )
    const attempts = sameRelease ? previous!.marker.attempts : 0
    const hasProductionEvidence =
      inspection.details !== null &&
      repo.environments.includes(incident.environment ?? '')
    const verification = hasProductionEvidence
      ? sameRelease &&
        previous?.marker.verification?.status !== 'evidence-unavailable'
        ? previous?.marker.verification
        : undefined
      : boundedVerification({
          status: 'evidence-unavailable',
          summary: `A verified production event is required before repair. ${inspection.errors.join('; ')}`
        })
    const marker: IncidentMarker = {
      version: 1,
      issueId: incident.issueId,
      project: incident.project,
      releaseKey,
      lastSeen: incident.lastSeen,
      attempts,
      priority: priority.priority,
      assessment: priority,
      flows,
      rootCause,
      status:
        attempts >= 2 || !hasProductionEvidence
          ? 'reported'
          : shouldRepair
            ? 'queued'
            : previous!.marker.status,
      ...(verification ? { verification } : {}),
      ...(sameRelease && previous?.marker.prUrl
        ? { prUrl: previous.marker.prUrl }
        : {}),
      ...(sameRelease &&
      previous?.marker.executionDeadline &&
      previous.marker.status !== 'budget-paused'
        ? { executionDeadline: previous.marker.executionDeadline }
        : {})
    }
    const body = renderIncidentReport({
      incident,
      flows,
      rootCause,
      priority,
      verification,
      ...(marker.prUrl ? { prUrl: marker.prUrl } : {})
    })
    const report = await upsertReport(
      gh,
      repo,
      `[${priority.priority}] ${incident.title}`,
      body,
      marker,
      previous?.number
    )
    if (
      shouldRepair &&
      hasProductionEvidence &&
      marker.attempts < 2 &&
      !marker.prUrl
    )
      queued.push({
        incident,
        marker,
        report,
        details: { sentry: inspection.details, limitations: inspection.errors },
        baseSha: base.commit.sha
      })
  }
  return queued
    .sort(
      (a, b) =>
        a.marker.priority.localeCompare(b.marker.priority) ||
        (b.incident.volume['15m'].events ?? 0) -
          (a.incident.volume['15m'].events ?? 0) ||
        a.incident.firstSeen.localeCompare(b.incident.firstSeen)
    )
    .slice(0, 10)
}

export async function evidenceForFixer(
  repo: RepositoryConfig,
  job: QueuedIncident
) {
  const parsed = z
    .object({
      sentry: z
        .object({
          timestamp: z.string().optional(),
          trace: z
            .object({ traceId: z.string().nullable().optional() })
            .optional()
        })
        .nullable()
        .optional()
    })
    .safeParse(job.details)
  const details = parsed.success ? parsed.data.sentry : null
  const now = Date.now()
  const observedAt = Date.parse(details?.timestamp ?? job.incident.lastSeen)
  const center = Number.isFinite(observedAt) ? Math.min(now, observedAt) : now
  const start = new Date(center - 900_000).toISOString()
  const end = new Date(Math.min(now, center + 900_000) + 1).toISOString()
  const deadline = Date.now() + 45_000
  const [relatedSentry, vercel] = await Promise.all([
    collectRelatedSentryTelemetry(repo, details?.trace?.traceId ?? undefined, {
      start,
      end,
      project: job.incident.project,
      deadline
    }),
    collectVercelEvidence(repo, {
      start,
      end,
      releaseSha: job.incident.releaseSha,
      deadline
    })
  ])
  return {
    ...job,
    details: { sentry: job.details, relatedSentry, vercel },
    repository: repo
  }
}

export async function updateReport(
  repo: RepositoryConfig,
  job: QueuedIncident,
  input: {
    flows?: FlowAssessment[]
    rootCause?: RootCause
    verification?: {
      status: string
      summary: string
      commands?: { command: string; exitCode: number; output: string }[]
      regression?: { before: number; after: number }
    }
    status: IncidentMarker['status']
    attempts?: number
    prUrl?: string
  }
) {
  const flows =
    input.flows ??
    (job.marker.flows ?? []).map((flow) => flowAssessmentSchema.parse(flow))
  const previousCause = rootCauseSchema.safeParse(job.marker.rootCause)
  const rootCause =
    input.rootCause ??
    (previousCause.success ? previousCause.data : unknownCause)
  const verification = boundedVerification(
    input.verification ?? job.marker.verification
  )
  const previous = priorityAssessmentSchema.safeParse(job.marker.assessment)
  const priority = assessPriority(
    job.incident,
    flows,
    previous.success ? previous.data : undefined,
    new Date(),
    repo.criticalFlows
  )
  const now = new Date()
  const pausedUntil =
    input.status === 'budget-paused'
      ? new Date(
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate() + 1
          )
        ).toISOString()
      : undefined
  const marker: IncidentMarker = {
    ...job.marker,
    status: input.status,
    priority: priority.priority,
    assessment: priority,
    flows,
    rootCause,
    updatedAt: now.toISOString(),
    attempts: input.attempts ?? job.marker.attempts,
    ...(input.prUrl ? { prUrl: input.prUrl } : {}),
    ...(pausedUntil ? { pausedUntil } : {}),
    ...(verification ? { verification } : {})
  }
  const body = renderIncidentReport({
    incident: job.incident,
    flows,
    rootCause,
    priority,
    verification,
    prUrl: input.prUrl ?? job.marker.prUrl
  })
  const report = await upsertReport(
    createGitHubClient(),
    repo,
    `[${priority.priority}] ${job.incident.title}`,
    body,
    marker,
    job.report.number
  )
  return { marker, body, report }
}
