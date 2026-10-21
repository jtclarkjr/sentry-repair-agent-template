import {
  type IncidentVolume,
  type IncidentEvidence,
  type FlowAssessment,
  type Priority,
  type PriorityAssessment
} from './model'

export type TrendAssessment = {
  direction: 'rising' | 'falling' | 'steady' | 'new' | 'unknown'
  current: number | null
  previous: number | null
  ratio?: number
}

export function assessTrend(volume: IncidentVolume): TrendAssessment {
  const current = volume['15m'].events
  const previous = volume.previous15m.events
  if (current === null || previous === null)
    return { direction: 'unknown', current, previous }
  if (previous === 0)
    return { direction: current > 0 ? 'new' : 'steady', current, previous }
  const ratio = current / previous
  let direction: TrendAssessment['direction'] = 'steady'
  if (current >= 10 && ratio >= 2) direction = 'rising'
  else if (previous >= 10 && ratio <= 0.5) direction = 'falling'
  return { direction, current, previous, ratio }
}

const DOWNGRADE_HOLD_MS = 30 * 60_000

export function assessPriority(
  incident: IncidentEvidence,
  flows: readonly FlowAssessment[],
  previous?: PriorityAssessment,
  now: Date = new Date(),
  criticalFlows: readonly { id: string; main: boolean }[] = []
): PriorityAssessment {
  const mainIds = new Set(
    criticalFlows.filter((flow) => flow.main).map((flow) => flow.id)
  )
  const supported = flows.filter((flow) => flow.evidence.length > 0)
  const blockedMain = supported.filter(
    (flow) => mainIds.has(flow.flowId) && flow.impact === 'blocked'
  )
  const degradedMain = supported.filter(
    (flow) => mainIds.has(flow.flowId) && flow.impact === 'degraded'
  )
  const dataLoss = supported.filter((flow) => flow.dataLoss)
  const verifiedDataLoss = dataLoss.some(
    (flow) => flow.confidence === 'verified'
  )
  const verifiedSystemWide = blockedMain.some(
    (flow) => flow.systemWide && flow.confidence === 'verified'
  )
  const highVolume =
    (incident.volume['15m'].events ?? 0) >= 100 ||
    (incident.volume['15m'].affectedUsers ?? 0) >= 10
  const unknownImpact =
    !flows.length ||
    flows.some(
      (flow) =>
        flow.impact === 'unknown' ||
        !flow.evidence.length ||
        flow.confidence !== 'verified'
    )
  let priority: Priority = 'P2'
  let reason =
    'P2 rule: impact is unknown below the P1 threshold, or repeated nonblocking failures require investigation.'
  if (verifiedDataLoss || verifiedSystemWide) {
    priority = 'P0'
    reason = verifiedDataLoss
      ? 'P0 rule: verified evidence indicates production data loss or corruption.'
      : 'P0 rule: a configured main flow is verified blocked system-wide.'
  } else if (blockedMain.length) {
    priority = 'P1'
    reason =
      'P1 rule: a configured main flow is blocked for an affected cohort.'
  } else if (highVolume && unknownImpact) {
    priority = 'P1'
    reason =
      'P1 rule: unknown impact reached 100 events or 10 identified affected users in 15 minutes.'
  } else if (
    degradedMain.length ||
    supported.some(
      (flow) =>
        flow.impact === 'blocked' || (flow.impact === 'degraded' && !flow.minor)
    )
  ) {
    reason =
      'P2 rule: a main flow remains usable with degradation or a workaround, or a secondary feature is broken.'
  } else if (
    !unknownImpact &&
    (supported.every((flow) => flow.minor) ||
      (incident.volume['24h'].events !== null &&
        incident.volume['24h'].events < 5 &&
        supported.every((flow) => flow.impact === 'unaffected')))
  ) {
    priority = 'P3'
    reason =
      'P3 rule: confirmed minor/cosmetic impact, or fewer than five events in 24 hours with an isolated nonblocking impact.'
  }
  const assessedAt = now.toISOString()
  const assessment: PriorityAssessment = {
    priority,
    provisional: priority === 'P0' ? false : unknownImpact,
    reasons: [reason],
    assessedAt,
    lastEscalatedAt: previous?.lastEscalatedAt ?? assessedAt,
    recoveryRequired:
      verifiedDataLoss ||
      blockedMain.some((flow) => flow.confidence === 'verified'),
    recoveryFlowIds: supported
      .filter(
        (flow) =>
          flow.confidence === 'verified' &&
          (dataLoss.includes(flow) || blockedMain.includes(flow))
      )
      .map((flow) => flow.flowId)
  }
  if (!previous) return assessment
  if (previous.recoveryRequired) {
    assessment.recoveryRequired = true
    assessment.recoveryFlowIds = [
      ...new Set([
        ...(previous.recoveryFlowIds ?? []),
        ...(assessment.recoveryFlowIds ?? [])
      ])
    ]
  }
  if (priority < previous.priority)
    return { ...assessment, lastEscalatedAt: assessedAt }
  if (priority === previous.priority) return assessment

  const deadline =
    previous.downgradeAfter ??
    new Date(now.getTime() + DOWNGRADE_HOLD_MS).toISOString()
  const holdStarted = Date.parse(deadline) - DOWNGRADE_HOLD_MS
  const recoveryIds = previous.recoveryFlowIds?.length
    ? previous.recoveryFlowIds
    : [...mainIds]
  const recovered =
    !previous.recoveryRequired ||
    (recoveryIds.length > 0 &&
      recoveryIds.every((id) =>
        supported.some(
          (flow) =>
            flow.flowId === id &&
            flow.confidence === 'verified' &&
            flow.impact === 'unaffected' &&
            !flow.dataLoss &&
            flow.checkedAt !== undefined &&
            Date.parse(flow.checkedAt) >= holdStarted
        )
      ))
  if (now.getTime() < Date.parse(deadline) || unknownImpact || !recovered) {
    return {
      ...assessment,
      priority: previous.priority,
      provisional: assessment.provisional || !recovered,
      recoveryRequired: previous.recoveryRequired,
      recoveryFlowIds: previous.recoveryFlowIds,
      downgradeAfter: deadline,
      reasons: [
        ...assessment.reasons,
        'Previous priority is retained for at least 30 minutes and until supported recovery is established.'
      ]
    }
  }
  return { ...assessment, recoveryRequired: false, recoveryFlowIds: [] }
}
