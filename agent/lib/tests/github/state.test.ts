import { test } from 'node:test'
import assert from 'node:assert/strict'
import { decodeMarker, encodeMarker } from '../../github/state'
import { marker } from '../fixtures/github'

test('report markers authenticate state and reject tampering or secret rotation', () => {
  const original = process.env.STATE_SIGNING_SECRET
  process.env.STATE_SIGNING_SECRET = 'synthetic-marker-signing-key'
  try {
    const encoded = encodeMarker(marker)
    assert.deepEqual(decodeMarker(encoded), marker)
    const changed = encoded.replace(
      'sentry-repair-agent:',
      'sentry-repair-agent:Z'
    )
    assert.equal(decodeMarker(changed), null)
    process.env.STATE_SIGNING_SECRET = 'different-signing-key'
    assert.equal(decodeMarker(encoded), null)
  } finally {
    if (original === undefined) delete process.env.STATE_SIGNING_SECRET
    else process.env.STATE_SIGNING_SECRET = original
  }
})

test('encoded report state cannot conceal credentials that the visible report redacts', () => {
  process.env.STATE_SIGNING_SECRET ??= 'synthetic-marker-signing-key'
  const encoded = encodeMarker({
    ...marker,
    rootCause: {
      summary: 'Authorization: Bearer secret-access-value',
      evidence: ['api_key="private-value"']
    },
    flows: [{ evidence: ['email private@example.com'] }]
  })
  const decoded = JSON.stringify(decodeMarker(encoded))
  for (const sensitive of [
    'secret-access-value',
    'private-value',
    'private@example.com'
  ])
    assert.equal(decoded.includes(sensitive), false)
})
