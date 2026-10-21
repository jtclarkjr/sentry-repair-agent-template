import { assessTrend } from './priority'
import { sanitizeText } from '../redaction'
import {
  type FlowAssessment,
  type IncidentEvidence,
  type PriorityAssessment,
  type RootCause
} from './model'

export type VerificationReport = {
  status: string
  summary: string
  commands?: { command: string; exitCode: number; output: string }[]
  regression?: { before: number; after: number }
}
export type IncidentReport = {
  incident: IncidentEvidence
  flows: readonly FlowAssessment[]
  rootCause: RootCause
  priority: PriorityAssessment
  verification?: VerificationReport
  prUrl?: string
}

function inline(value: string): string {
  return sanitizeText(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/([\\`*_{}\[\]()#+.!|~])/g, '\\$1')
    .replace(/[\r\n]+/g, ' ')
}

function reportUrl(value: string): string | undefined {
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:') return undefined
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString().replace(/\(/g, '%28').replace(/\)/g, '%29')
  } catch {
    return undefined
  }
}

function count(value: number | null): string {
  return value === null
    ? 'Unknown'
    : new Intl.NumberFormat('en-US').format(value)
}

export function incidentMarker(
  incident: Pick<IncidentEvidence, 'org' | 'project' | 'issueId'>
): string {
  return `<!-- sentry-repair-agent:${[incident.org, incident.project, incident.issueId].map(encodeURIComponent).join(':')} -->`
}

export function renderIncidentReport(report: IncidentReport): string {
  const { incident, priority, rootCause, flows, verification } = report
  const issueUrl = reportUrl(incident.url)
  const lines = [
    incidentMarker(incident),
    `## ${priority.priority}: ${inline(incident.title)}`,
    '',
    `**Priority:** ${priority.priority}${priority.provisional ? ' (provisional)' : ''}`,
    `**Assessed:** ${inline(priority.assessedAt)} · **Environment:** ${inline(incident.environment ?? 'Unknown')}`,
    `**Source:** ${issueUrl ? `[Sentry issue](${issueUrl})` : 'Sentry issue URL unavailable'}`,
    `**First seen:** ${inline(incident.firstSeen)} · **Last seen:** ${inline(incident.lastSeen)}`
  ]
  lines.push(
    `**Deployed release/SHA:** ${incident.releaseSha ? inline(incident.releaseSha) : 'Unknown'}`
  )
  lines.push('', ...priority.reasons.map((reason) => `- ${inline(reason)}`))
  if (priority.downgradeAfter)
    lines.push(
      `- Downgrade hold: ${inline(priority.downgradeAfter)}; supported recovery is required.`
    )
  lines.push('', '### Impact', '')
  if (!flows.length)
    lines.push('Unknown; no supported flow assessment is available.')
  for (const flow of flows) {
    lines.push(
      `- **${inline(flow.flowId)}:** ${flow.impact} (${flow.confidence ?? 'unknown'})${flow.systemWide ? '; system-wide blockage' : ''}${flow.dataLoss ? '; data loss' : ''}${flow.cohort ? `; cohort: ${inline(flow.cohort)}` : ''}`
    )
    lines.push(
      `  - Workaround: ${flow.workaround ?? 'unknown'}${flow.workaroundDetails ? `; ${inline(flow.workaroundDetails)}` : ''}.`
    )
    for (const evidence of flow.evidence) lines.push(`  - ${inline(evidence)}`)
  }
  lines.push(
    '',
    '### Volume',
    '',
    `**Count windows ended:** ${incident.volumeObservedAt ? inline(incident.volumeObservedAt) : 'Unknown (measurement time unavailable)'}`,
    '',
    '| Window | Events | Identified affected users |',
    '| --- | ---: | ---: |'
  )
  for (const window of ['15m', '1h', '24h'] as const) {
    lines.push(
      `| ${window} | ${count(incident.volume[window].events)} | ${count(incident.volume[window].affectedUsers)} |`
    )
  }
  const trend = assessTrend(incident.volume)
  lines.push(
    '',
    `**Trend:** ${trend.direction}; latest measured 15m ${count(trend.current)} events, preceding 15m ${count(trend.previous)} events.`,
    'User counts can overlap across windows; missing identities are unknown. No failure rate is inferred without attempted-operation counts.',
    '',
    `### Root cause (${rootCause.confidence})`,
    '',
    inline(rootCause.summary),
    '',
    `**Trigger:** ${rootCause.trigger ? inline(rootCause.trigger) : 'Unknown'}`,
    `**Relevant code:** ${rootCause.code?.length ? rootCause.code.map(inline).join(', ') : 'Unknown'}`
  )
  if (!rootCause.evidence.length)
    lines.push(
      '',
      'Supporting evidence is insufficient to establish a root cause.'
    )
  else
    lines.push(
      '',
      ...rootCause.evidence.map((evidence) => `- ${inline(evidence)}`)
    )
  if (rootCause.unknowns.length)
    lines.push(
      '',
      '**Remaining uncertainty:**',
      '',
      ...rootCause.unknowns.map((unknown) => `- ${inline(unknown)}`)
    )
  lines.push('', '### Verification and next action', '')
  if (!verification)
    lines.push(
      'Investigation pending. Reproduce the failure before claiming a verified fix.'
    )
  else {
    lines.push(
      `**Status:** ${inline(verification.status)}`,
      '',
      inline(verification.summary)
    )
    if (verification.regression)
      lines.push(
        '',
        `Regression exit codes: baseline ${verification.regression.before}; candidate ${verification.regression.after}.`
      )
    for (const command of verification.commands ?? []) {
      lines.push(
        '',
        `- ${inline(command.command)} — exit ${command.exitCode}`,
        `  - ${inline(sanitizeText(command.output, 2_000))}`
      )
    }
  }
  const prUrl = report.prUrl ? reportUrl(report.prUrl) : undefined
  if (prUrl) lines.push('', `[Proposed fix](${prUrl})`)
  return lines.join('\n')
}
