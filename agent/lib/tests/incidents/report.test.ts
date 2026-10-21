import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { assessPriority } from '../../incidents/priority'
import { incidentEvidenceSchema, rootCauseSchema } from '../../incidents/model'
import { incidentMarker, renderIncidentReport } from '../../incidents/report'
import { criticalFlows, flow, incident, instant } from '../fixtures/incidents'

test('reports label flow confidence alongside provisional priority', () => {
  const evidence = incident()
  const probable = { ...flow(), confidence: 'probable' as const }
  const body = renderIncidentReport({
    incident: evidence,
    flows: [probable],
    priority: assessPriority(
      evidence,
      [probable],
      undefined,
      instant,
      criticalFlows
    ),
    rootCause: rootCauseSchema.parse({
      confidence: 'probable',
      summary: 'Reproduction identifies a candidate failure.',
      evidence: ['Causal regression failed baseline and passed candidate']
    })
  })
  assert.ok(body.includes('P1 (provisional)'))
  assert.ok(body.includes('blocked (probable)'))
})

test('verified harmless cosmetic volume is P3 and report fields remain explicit when unknown', () => {
  const cosmetic = { ...flow('voice', 'unaffected'), minor: true }
  const evidence = incident(1000)
  const priority = assessPriority(
    evidence,
    [cosmetic],
    undefined,
    instant,
    criticalFlows
  )
  assert.equal(priority.priority, 'P3')
  const body = renderIncidentReport({
    incident: evidence,
    flows: [cosmetic],
    priority,
    rootCause: {
      confidence: 'undetermined',
      summary: 'Cosmetic report',
      evidence: [],
      unknowns: []
    }
  })
  for (const field of [
    'Workaround: unknown',
    '**Trigger:** Unknown',
    '**Relevant code:** Unknown',
    '**Deployed release/SHA:** Unknown',
    '**Count windows ended:** Unknown (measurement time unavailable)'
  ])
    assert.ok(body.includes(field), field)
})

test('reports label the volume measurement window separately from a later assessment', () => {
  const observedAt = '2026-10-21T04:00:00.000Z'
  const evidence = incidentEvidenceSchema.parse({
    ...incident(),
    volumeObservedAt: observedAt
  })
  assert.equal(
    incidentEvidenceSchema.safeParse({
      ...incident(),
      volumeObservedAt: 'yesterday'
    }).success,
    false
  )
  const report = renderIncidentReport({
    incident: evidence,
    flows: [],
    priority: assessPriority(
      evidence,
      [],
      undefined,
      new Date('2026-10-21T05:00:00.000Z'),
      criticalFlows
    ),
    rootCause: {
      confidence: 'undetermined',
      summary: 'Awaiting evidence',
      evidence: [],
      unknowns: []
    }
  })
  assert.ok(
    report.includes(
      `**Count windows ended:** ${observedAt.replace('.', '\\.')}`
    )
  )
  assert.ok(report.includes('**Assessed:** 2026-10-21T05:00:00\\.000Z'))
  assert.ok(report.includes('latest measured 15m'))
  assert.equal(report.includes('current 15m'), false)
})

test('every report includes RCA, priority inputs, unknown metrics, verification, and an incident marker', () => {
  const evidence = incident(1, null)
  const report = renderIncidentReport({
    incident: {
      ...evidence,
      title: '<script>alert(1)</script> [click](javascript:alert(1))'
    },
    flows: [flow('ai', 'unknown')],
    priority: assessPriority(evidence, [], undefined, instant, criticalFlows),
    rootCause: rootCauseSchema.parse({
      confidence: 'undetermined',
      summary: 'No reliable causal evidence yet.',
      unknowns: ['Reproduction unavailable']
    }),
    verification: {
      status: 'blocked',
      summary: 'Need fixtures',
      commands: [
        { command: 'bun test', exitCode: 1, output: 'api_key=do-not-publish' }
      ]
    }
  })
  for (const heading of [
    'Priority:',
    'Impact',
    'Volume',
    'Root cause (undetermined)',
    'Verification and next action'
  ])
    assert.ok(report.includes(heading), heading)
  assert.ok(report.includes('| 15m | 1 | Unknown |'))
  assert.ok(report.includes(incidentMarker(evidence)))
  assert.equal(report.includes('<script>'), false)
  assert.equal(report.includes('[click](javascript:'), false)
  assert.equal(report.includes('do-not-publish'), false)
})
