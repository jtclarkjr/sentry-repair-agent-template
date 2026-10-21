import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planActiveRefresh, refreshActiveIncident } from '../../incidents/active-incident'
import { activeWaitDelay, carryReport } from '../../repair/policy'
import { assessPriority } from '../../incidents/priority'
import { type IncidentEvidence } from '../../incidents/model'
import type { QueuedIncident } from '../../incidents/queue'
import { repositories } from '../../registry'

const repo = repositories[0]!
const sha = 'a'.repeat(40)
const observed = '2026-10-21T02:00:00.000Z'
function job(): QueuedIncident {
  const incident: IncidentEvidence = {
    org: repo.projects[0]!.org,
    project: repo.projects[0]!.slug,
    issueId: '123',
    title: 'AI response fails',
    url: 'https://sentry.io/organizations/your-sentry-org/issues/123/',
    firstSeen: '2026-10-21T00:00:00.000Z',
    lastSeen: '2026-10-21T01:00:00.000Z',
    environment: 'production',
    releaseSha: sha,
    volumeObservedAt: '2026-10-21T01:00:00.000Z',
    volume: {
      '15m': { events: 1, affectedUsers: 1 },
      '1h': { events: 2, affectedUsers: 1 },
      '24h': { events: 2, affectedUsers: 1 },
      previous15m: { events: 1, affectedUsers: 1 }
    }
  }
  const marker = {
    version: 1 as const,
    issueId: '123',
    project: incident.project,
    releaseKey: sha,
    lastSeen: incident.lastSeen,
    attempts: 1,
    priority: 'P2' as const,
    status: 'investigating' as const,
    assessment: assessPriority(
      incident,
      [],
      undefined,
      new Date('2026-10-21T01:00:00Z'),
      repo.criticalFlows
    ),
    executionDeadline: '2026-10-21T03:00:00.000Z',
    rootCause: {
      confidence: 'probable',
      summary: 'Earlier parser hypothesis.',
      evidence: ['Old release stack'],
      unknowns: []
    },
    flows: []
  }
  return {
    incident,
    marker,
    report: {
      number: 7,
      html_url: 'https://github.com/example/issues/7',
      body: 'Old report',
      marker
    },
    details: {},
    baseSha: sha
  }
}
function inspection(current = job()) {
  return {
    incident: {
      ...current.incident,
      releaseSha: sha,
      volumeObservedAt: observed,
      volume: {
        ...current.incident.volume,
        '15m': { events: 101, affectedUsers: 11 }
      }
    },
    details: {
      eventId: 'event-2',
      timestamp: '2026-10-21T01:59:00.000Z',
      environment: 'production',
      exceptions: [],
      breadcrumbs: [],
      trace: { traceId: null, spanId: null, operation: null },
      release: { version: sha, sha }
    },
    errors: [] as string[]
  }
}

test('refresh carries measured counts and existing priority hold metadata within the same release', () => {
  const current = job()
  const previousAssessment = {
    ...(current.marker.assessment as object),
    downgradeAfter: '2026-10-21T02:30:00.000Z'
  }
  current.marker.assessment = previousAssessment
  const plan = planActiveRefresh(repo, current, inspection(current), 1)
  assert.equal(plan.state, 'current')
  assert.equal(plan.job.incident.volume['15m'].events, 101)
  assert.equal(plan.job.incident.volumeObservedAt, observed)
  assert.equal(plan.job.incident.lastSeen, '2026-10-21T01:59:00.000Z')
  assert.deepEqual(plan.job.marker.assessment, previousAssessment)
  assert.deepEqual(plan.job.marker.rootCause, current.marker.rootCause)
  assert.equal(
    plan.job.marker.executionDeadline,
    current.marker.executionDeadline
  )
  assert.deepEqual(plan.update, { status: 'investigating', attempts: 1 })
})

test('a new production release stops old work and resets RCA, PR, attempts, and deadline for fresh triage', () => {
  const current = job()
  current.marker.prUrl = 'https://github.com/example/pull/1'
  const next = inspection(current)
  next.details.release = { sha: 'b'.repeat(40), version: 'b'.repeat(40) }
  next.incident.releaseSha = 'b'.repeat(40)
  const plan = planActiveRefresh(repo, current, next, 2)
  assert.equal(plan.state, 'changed')
  assert.equal(plan.job.marker.releaseKey, 'b'.repeat(40))
  assert.equal(plan.job.marker.prUrl, undefined)
  assert.equal(plan.job.marker.executionDeadline, undefined)
  assert.equal(plan.job.marker.assessment, undefined)
  assert.equal(plan.job.marker.rootCause, undefined)
  assert.deepEqual(plan.update.flows, [])
  assert.equal(plan.update.rootCause?.confidence, 'undetermined')
  assert.equal(plan.update.status, 'queued')
  assert.equal(plan.update.attempts, 0)
  assert.doesNotMatch(
    JSON.stringify({ marker: plan.job.marker, update: plan.update }),
    /Earlier parser hypothesis|Old release stack/
  )
})

test('a cached incident SHA cannot substitute for fresh safe production event evidence', () => {
  const current = job()
  const next = inspection(current)
  for (const details of [
    null,
    { ...next.details, environment: 'preview' },
    { ...next.details, release: { version: null, sha: undefined } }
  ]) {
    const plan = planActiveRefresh(repo, current, { ...next, details }, 1)
    assert.equal(plan.state, 'unavailable')
    assert.equal(plan.update.status, 'reported')
    assert.equal(plan.update.verification?.status, 'evidence-unavailable')
    assert.equal(plan.job.marker.releaseKey, sha)
  }
})

test('the authored refresh adapter performs one inspection and one report update without resetting escalation history', async () => {
  const current = job()
  let inspections = 0
  let writes = 0
  const refreshed = await refreshActiveIncident(
    repo,
    current,
    1,
    Date.now() + 60_000,
    {
      inspect: async (_repo, incident, options) => {
        inspections++
        assert.equal(incident.issueId, '123')
        assert.ok(options?.deadline)
        return inspection(current)
      },
      update: async (_repo, measured, input) => {
        writes++
        const assessment = assessPriority(
          measured.incident,
          [],
          current.marker.assessment as any,
          new Date(observed),
          repo.criticalFlows
        )
        const marker = {
          ...measured.marker,
          ...input,
          assessment,
          priority: assessment.priority
        }
        return {
          marker,
          body: 'Updated report',
          report: { ...measured.report, marker }
        }
      }
    }
  )
  assert.equal(inspections, 1)
  assert.equal(writes, 1)
  assert.equal(refreshed.state, 'current')
  assert.equal(refreshed.job.marker.priority, 'P1')
  assert.equal(refreshed.job.marker.attempts, 1)
  assert.equal(refreshed.job.incident.volumeObservedAt, observed)
  assert.equal(
    refreshed.job.marker.executionDeadline,
    current.marker.executionDeadline
  )
})

test('five-minute timers respect remaining stage/overall time and updated markers are carried forward', () => {
  assert.equal(activeWaitDelay(3_600_000), 300_000)
  assert.equal(activeWaitDelay(42_000), 42_000)
  assert.equal(activeWaitDelay(0), 0)
  assert.equal(activeWaitDelay(-1), 0)
  const current = job()
  const marker = { ...current.marker, attempts: 2, priority: 'P1' as const }
  assert.equal(
    carryReport(current, {
      marker,
      body: 'New report',
      report: { ...current.report, marker }
    }).marker.attempts,
    2
  )
})
