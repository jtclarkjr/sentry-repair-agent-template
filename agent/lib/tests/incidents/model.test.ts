import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { flowAssessmentSchema, incidentEvidenceSchema, rootCauseSchema } from '../../incidents/model'
import { incident } from '../fixtures/incidents'

test('trust boundaries reject unsupported impact/root-cause claims and invalid evidence', () => {
  assert.equal(
    flowAssessmentSchema.safeParse({
      flowId: 'ai',
      impact: 'unknown',
      dataLoss: true
    }).success,
    false
  )
  assert.equal(
    flowAssessmentSchema.safeParse({ flowId: 'ai', impact: 'blocked' }).success,
    false
  )
  assert.equal(
    rootCauseSchema.safeParse({
      confidence: 'confirmed',
      summary: 'It failed.'
    }).success,
    false
  )
  assert.equal(
    incidentEvidenceSchema.safeParse({
      ...incident(),
      volume: {
        ...incident().volume,
        '15m': { events: -1, affectedUsers: null }
      }
    }).success,
    false
  )
})
