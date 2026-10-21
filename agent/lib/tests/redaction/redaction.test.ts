import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { redactTelemetryText, sanitizeText } from '../../redaction'

test('sanitization removes credentials, query values, emails, cookies, and notification mentions', () => {
  const original = [
    'Authorization: Bearer super-secret-token-value',
    'api_key="secret-api-value"',
    'Cookie: session=private-session; csrf=private-csrf',
    'https://username:password@example.com/api?email=alice@example.com&search=private-query#private-fragment',
    'alice@example.com @maintainer github_pat_abcdef1234567890',
    '-----BEGIN PRIVATE KEY-----\nprivate-key-body\n-----END PRIVATE KEY-----'
  ].join('\n')
  const cleaned = sanitizeText(original)
  for (const secret of [
    'super-secret-token-value',
    'secret-api-value',
    'private-session',
    'private-csrf',
    'username',
    'password@',
    'alice@example.com',
    'private-query',
    'private-fragment',
    'abcdef1234567890',
    'private-key-body'
  ])
    assert.equal(cleaned.includes(secret), false, secret)
  assert.equal(cleaned.includes('@maintainer'), false)
  assert.equal(cleaned.includes('[REDACTED'), true)
  assert.ok(cleaned.includes('example.com/api'))
})

test('redacts common identifiers, credential assignments, query strings and configured secrets', () => {
  const result = redactTelemetryText(
    'https://user:pass@example.com/a?token=foo#hash /api/items?token=foo api_key="abc" user@example.com 192.168.1.1 2001:db8::1 Bearer abc known-secret',
    ['known-secret']
  )
  for (const sensitive of [
    'user:pass',
    '?token',
    '"abc"',
    'user@example.com',
    '192.168',
    '2001:db8',
    'Bearer abc',
    'known-secret'
  ])
    assert.equal(result.includes(sensitive), false)
  assert.equal(redactTelemetryText('x'.repeat(1000)).length, 800)
  assert.equal(
    redactTelemetryText(
      '{"password":"private-password","cookie":"session=private-session","apiKey":"private-key"}'
    ).includes('private-'),
    false
  )
})
