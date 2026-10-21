import {
  flowAssessmentSchema,
  incidentEvidenceSchema,
  type IncidentEvidence
} from '../../incidents/model'

export const instant = new Date('2026-10-21T00:00:00Z')
export const criticalFlows = [
  { id: 'ai', main: true },
  { id: 'auth', main: true },
  { id: 'voice', main: false }
]
export function incident(
  events = 1,
  affectedUsers: number | null = 1
): IncidentEvidence {
  return incidentEvidenceSchema.parse({
    org: 'test-org',
    project: 'web',
    issueId: '123',
    title: 'AI response failed',
    url: 'https://sentry.io/issues/123/',
    environment: 'production',
    firstSeen: instant.toISOString(),
    lastSeen: instant.toISOString(),
    volume: {
      '15m': { events, affectedUsers },
      '1h': { events, affectedUsers },
      '24h': { events, affectedUsers },
      previous15m: { events: 0, affectedUsers: 0 }
    }
  })
}
export function flow(
  flowId = 'ai',
  impact: 'blocked' | 'degraded' | 'unaffected' | 'unknown' = 'blocked',
  systemWide = false,
  checkedAt = instant.toISOString()
) {
  return flowAssessmentSchema.parse({
    flowId,
    impact,
    systemWide,
    checkedAt,
    confidence: impact === 'unknown' ? 'unknown' : 'verified',
    evidence:
      impact === 'unknown' ? [] : ['Verified flow check trace trace-123']
  })
}
