import {
  flowAssessmentSchema,
  rootCauseSchema,
  type FlowAssessment,
  type IncidentEvidence,
  type RootCause
} from '../incidents/model'
import { sanitizeText } from '../redaction'
import { type RepositoryConfig } from '../registry'
import { type VerificationReport } from '../incidents/report'
import { type QueuedIncident, type updateReport } from '../incidents/queue'

export function activeWaitDelay(remaining: number): number {
  return Math.max(0, Math.min(300_000, remaining))
}

export function carryReport(
  job: QueuedIncident,
  result: Awaited<ReturnType<typeof updateReport>>
): QueuedIncident {
  return { ...job, marker: result.marker, report: result.report }
}

export type CandidateReportContext = {
  rootCause: RootCause
  flows: FlowAssessment[]
}
type DeploymentEvidence = { state: string | null; sha: string | null }

export function browserVerificationBlocker(
  repo: RepositoryConfig,
  browserRequired: boolean,
  paths: readonly string[]
): string | undefined {
  const uiChange = paths.some((path) =>
    /\.(?:tsx|jsx|svelte)$|(?:^|\/)(?:components|hooks)\/|(?:^|\/)(?:\+page|\+layout)\.[cm]?[jt]s$/.test(
      path
    )
  )
  if (
    repo.browserVerification === 'report-only' &&
    (browserRequired || uiChange)
  )
    return 'Browser-affected fixes are report-only by the configured rollout policy. Required browser fixtures and platform checks have not been configured; a model browser-coverage claim cannot authorize a fix PR.'
  return undefined
}

// This input comes only from the authored telemetry adapters, never the model.
export function repairBlockers(
  repo: RepositoryConfig,
  incident: IncidentEvidence,
  baseSha: string,
  deployments: readonly DeploymentEvidence[]
): string[] {
  const blockers: string[] = []
  const baseline = repo.repairReadiness.baseline
  if (
    baseline.status !== 'verified' ||
    !/^[a-f0-9]{40}$/.test(baseline.sha ?? '') ||
    !baseline.evidence.trim()
  )
    blockers.push(`Clean baseline profile is pending: ${baseline.evidence}`)
  if (
    repo.repairReadiness.sourceMaps.status !== 'verified' ||
    !repo.repairReadiness.sourceMaps.evidence.trim()
  )
    blockers.push(
      `Source-map and release rollout verification is pending: ${repo.repairReadiness.sourceMaps.evidence}`
    )
  if (!repo.environments.includes(incident.environment ?? ''))
    blockers.push(
      'A verified event in an allowlisted production environment is required.'
    )
  if (!/^[a-f0-9]{40}$/.test(incident.releaseSha ?? ''))
    blockers.push(
      'The production event has no verified full GitHub release SHA.'
    )
  else {
    if (incident.releaseSha !== baseSha)
      blockers.push(
        'The current default branch differs from the deployed release. This initial rollout requires an exact commit match; it does not establish that the incident is unfixable.'
      )
    if (
      deployments.length > 0 &&
      !deployments.some(
        (deployment) =>
          deployment.sha === incident.releaseSha && deployment.state === 'READY'
      )
    )
      blockers.push(
        'Returned Vercel production deployment metadata has no READY deployment matching the Sentry release SHA.'
      )
  }
  return blockers
}

export function withOptionalVercelUncertainty<T extends VerificationReport>(
  verification: T,
  evidence: {
    deployments: readonly DeploymentEvidence[]
    errors: readonly string[]
    historicalLogsComplete: boolean
  }
): T {
  const notes: string[] = []
  if (!evidence.deployments.length)
    notes.push(
      'Deployment metadata is unavailable; Vercel API release correlation was not independently checked.'
    )
  if (!evidence.historicalLogsComplete)
    notes.push(
      'Runtime logs provide a bounded live sample at most; complete historical log coverage is unavailable.'
    )
  notes.push(
    ...evidence.errors.slice(0, 2).map((error) => sanitizeText(error, 180))
  )
  return notes.length
    ? {
        ...verification,
        summary: `${verification.summary}\nOptional Vercel telemetry uncertainty: ${[...new Set(notes)].join(' ')}`
      }
    : verification
}

// Keep independently valid RCA even when the model's patch envelope is invalid.
export function candidateReportContext(
  value: unknown
): CandidateReportContext | undefined {
  if (!value || typeof value !== 'object') return undefined
  const input = value as Record<string, unknown>
  const rootCause = rootCauseSchema.safeParse(input.rootCause)
  if (!rootCause.success) return undefined
  const flows = Array.isArray(input.flows)
    ? input.flows.slice(0, 10).flatMap((value) => {
        const parsed = flowAssessmentSchema.safeParse(value)
        return parsed.success ? [parsed.data] : []
      })
    : []
  return {
    rootCause: {
      ...rootCause.data,
      confidence:
        rootCause.data.confidence === 'confirmed'
          ? 'probable'
          : rootCause.data.confidence
    },
    flows
  }
}

export function unverifiedFlows(
  context: CandidateReportContext
): FlowAssessment[] {
  return context.flows.map((flow) => ({
    ...flow,
    impact: 'unknown',
    confidence: 'unknown',
    systemWide: false,
    dataLoss: false,
    evidence: [
      ...flow.evidence,
      'Independent causal verification is incomplete; production flow impact remains unknown.'
    ]
  }))
}

export function blockedVerification(
  message: string,
  previous?: VerificationReport
): VerificationReport {
  const summary =
    previous?.summary && previous.summary !== message
      ? `${previous.summary}\n${message}`
      : message
  return {
    ...previous,
    status: 'blocked',
    summary: sanitizeText(summary),
    ...(previous?.commands ? { commands: previous.commands } : {})
  }
}

export function recordedAttempts(
  attempts: number,
  budgetPaused: boolean
): number {
  return budgetPaused ? Math.max(0, attempts - 1) : attempts
}

export function isGatewayBudgetFailure(error: unknown): boolean {
  const visited = new Set<object>()
  const inspect = (value: unknown, depth: number): boolean => {
    if (depth > 8 || value === null || value === undefined) return false
    if (typeof value === 'string') {
      const message = value.slice(0, 16_000)
      if (
        /\b(?:insufficient[_ -](?:credit|credits|quota)|(?:budget|credits?)[_ -](?:exceeded|exhausted)|quota_exceeded|quota_for_entity_exceeded)\b|\b(?:AI[ -]?)?Gateway\b.{0,80}\b(?:budget|credits?)\b/i.test(
          message
        )
      )
        return true
      try {
        return inspect(JSON.parse(message), depth + 1)
      } catch {
        return false
      }
    }
    if (typeof value !== 'object' || visited.has(value)) return false
    visited.add(value)
    const record = value as Record<string, unknown>
    if (
      [record.statusCode, record.status].some(
        (status) => status === 402 || status === '402'
      )
    )
      return true
    return [
      'code',
      'message',
      'cause',
      'error',
      'data',
      'response',
      'responseBody'
    ].some((key) => inspect(record[key], depth + 1))
  }
  return inspect(error, 0)
}

export function withTestEnvironment(
  repo: RepositoryConfig,
  command: string
): string {
  const assignments = Object.entries(repo.testEnvironment).map(
    ([key, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key))
        throw new Error('Invalid configured test environment key')
      return `${key}='${value.replaceAll("'", "'\\''")}'`
    }
  )
  return assignments.length
    ? `export ${assignments.join(' ')}; ${command}`
    : command
}
