import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { assessPriority, assessTrend } from '../../incidents/priority'
import { flowAssessmentSchema } from '../../incidents/model'
import { criticalFlows, flow, incident, instant } from '../fixtures/incidents'

test('main-flow impact outranks volume while voice remains secondary', () => {
  assert.equal(
    assessPriority(incident(), [flow()], undefined, instant, criticalFlows)
      .priority,
    'P1'
  )
  assert.equal(
    assessPriority(
      incident(),
      [flow('ai', 'blocked', true)],
      undefined,
      instant,
      criticalFlows
    ).priority,
    'P0'
  )
  assert.notEqual(
    assessPriority(
      incident(),
      [flow('voice', 'blocked', true)],
      undefined,
      instant,
      criticalFlows
    ).priority,
    'P0'
  )
  const confirmedDataLoss = flowAssessmentSchema.parse({
    flowId: 'ai',
    impact: 'degraded',
    confidence: 'verified',
    dataLoss: true,
    evidence: ['Stored AI response lost confirmed content']
  })
  assert.equal(
    assessPriority(
      incident(),
      [confirmedDataLoss],
      undefined,
      instant,
      criticalFlows
    ).priority,
    'P0'
  )
})

test('probable main-flow impact is provisional P1 and cannot establish P0', () => {
  const probable = {
    ...flow('ai', 'blocked', true),
    confidence: 'probable' as const
  }
  const assessment = assessPriority(
    incident(),
    [probable],
    undefined,
    instant,
    criticalFlows
  )
  assert.equal(assessment.priority, 'P1')
  assert.equal(assessment.provisional, true)
  assert.equal(
    assessPriority(
      incident(),
      [{ ...probable, dataLoss: true }],
      undefined,
      instant,
      criticalFlows
    ).priority,
    'P1'
  )
  assert.equal(
    assessPriority(
      incident(),
      [{ ...flow('voice', 'blocked', true), dataLoss: true }],
      undefined,
      instant,
      criticalFlows
    ).priority,
    'P0'
  )
  assert.equal(
    flowAssessmentSchema.parse({ flowId: 'ai', impact: 'unknown' }).confidence,
    'unknown'
  )
})

test('unknown impact and users remain unknown; volume can escalate without a denominator', () => {
  const result = assessPriority(
    incident(100, null),
    [],
    undefined,
    instant,
    criticalFlows
  )
  assert.equal(result.priority, 'P1')
  assert.equal(result.provisional, true)
  assert.equal(
    assessPriority(incident(1, 10), [], undefined, instant, criticalFlows)
      .priority,
    'P1'
  )
  assert.equal(
    assessPriority(incident(1, null), [], undefined, instant, criticalFlows)
      .priority,
    'P2'
  )
})

test('usable main-flow degradation and known secondary failures remain P2 regardless of volume', () => {
  const degraded = {
    ...flow('ai', 'degraded'),
    workaround: 'available' as const
  }
  assert.equal(
    assessPriority(incident(1), [degraded], undefined, instant, criticalFlows)
      .priority,
    'P2'
  )
  assert.equal(
    assessPriority(
      incident(1000),
      [degraded],
      undefined,
      instant,
      criticalFlows
    ).priority,
    'P2'
  )
  assert.equal(
    assessPriority(
      incident(1),
      [flow('voice', 'blocked')],
      undefined,
      instant,
      criticalFlows
    ).priority,
    'P2'
  )
  assert.equal(
    assessPriority(
      incident(1000),
      [flow('voice', 'blocked')],
      undefined,
      instant,
      criticalFlows
    ).priority,
    'P2'
  )
  assert.equal(
    assessPriority(
      incident(1),
      [{ ...degraded, confidence: 'probable' as const }],
      undefined,
      instant,
      criticalFlows
    ).priority,
    'P2'
  )
})

test('trend has a minimum sample and handles a missing or zero baseline', () => {
  const volume = incident().volume
  assert.equal(
    assessTrend({
      ...volume,
      '15m': { events: 8, affectedUsers: null },
      previous15m: { events: 2, affectedUsers: null }
    }).direction,
    'steady'
  )
  assert.equal(
    assessTrend({
      ...volume,
      '15m': { events: 10, affectedUsers: null },
      previous15m: { events: 5, affectedUsers: null }
    }).direction,
    'rising'
  )
  assert.equal(assessTrend(volume).direction, 'new')
  assert.equal(
    assessTrend({
      ...volume,
      previous15m: { events: null, affectedUsers: null }
    }).direction,
    'unknown'
  )
})

test('downgrade waits 30 minutes and requires recovery of every previously blocked flow', () => {
  const outage = assessPriority(
    incident(),
    [flow('ai', 'blocked', true)],
    undefined,
    instant,
    criticalFlows
  )
  const recoveryAt = new Date(instant.getTime() + 60_000)
  const recovery = flow('ai', 'unaffected', false, recoveryAt.toISOString())
  const held = assessPriority(
    incident(),
    [recovery],
    outage,
    recoveryAt,
    criticalFlows
  )
  assert.equal(held.priority, 'P0')
  const later = new Date(recoveryAt.getTime() + 30 * 60_000)
  assert.equal(
    assessPriority(
      incident(),
      [flow('auth', 'unaffected', false, later.toISOString())],
      held,
      later,
      criticalFlows
    ).priority,
    'P0'
  )
  assert.equal(
    assessPriority(
      incident(),
      [flow('ai', 'unknown')],
      held,
      later,
      criticalFlows
    ).priority,
    'P0'
  )
  assert.equal(
    assessPriority(incident(), [recovery], held, later, criticalFlows).priority,
    'P3'
  )
})

test('escalation is immediate and cancels the pending downgrade', () => {
  const initial = assessPriority(
    incident(),
    [flow('voice', 'unaffected')],
    undefined,
    instant,
    criticalFlows
  )
  const escalated = assessPriority(
    incident(),
    [flow('ai', 'blocked', true)],
    initial,
    new Date(instant.getTime() + 1_000),
    criticalFlows
  )
  assert.equal(escalated.priority, 'P0')
  assert.equal(escalated.downgradeAfter, undefined)
})
