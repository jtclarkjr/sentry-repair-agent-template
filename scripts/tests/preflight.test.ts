import { describe, expect, test } from 'bun:test'
import { generateKeyPairSync } from 'node:crypto'
import { checkEnvironment } from '../preflight'

const key = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString()
const configured = {
  SENTRY_AUTH_TOKEN: 'test-token-never-print',
  SENTRY_WEBHOOK_SECRET: 'test-secret-never-print',
  GITHUB_APP_ID: '1234',
  GITHUB_INSTALLATION_ID: '5678',
  GITHUB_APP_PRIVATE_KEY: key.replaceAll('\n', '\\n'),
  CRON_SECRET: 'x'.repeat(32),
  STATE_SIGNING_SECRET: 'y'.repeat(32),
  MONITOR_ENABLED: 'false'
}

describe('preflight environment', () => {
  test('accepts configured disabled service and escaped RSA PEM', () => {
    const checks = checkEnvironment(configured)
    expect(checks.every((check) => check.ok)).toBe(true)
    expect(JSON.stringify(checks)).not.toContain(configured.SENTRY_AUTH_TOKEN)
    expect(JSON.stringify(checks)).not.toContain(
      configured.SENTRY_WEBHOOK_SECRET
    )
    expect(JSON.stringify(checks)).not.toContain(key)
  })

  test('rejects missing credentials and accidental activation values', () => {
    expect(
      checkEnvironment({}).filter((check) => !check.ok).length
    ).toBeGreaterThan(0)
    expect(
      checkEnvironment({
        ...configured,
        MONITOR_ENABLED: 'yes',
        CRON_SECRET: 'short',
        GITHUB_APP_ID: '../escape',
        GITHUB_APP_PRIVATE_KEY: 'not a private key'
      })
        .filter((check) => !check.ok)
        .map((check) => check.name)
    ).toEqual([
      'GITHUB_APP_ID format',
      'GitHub signing key',
      'Cron authentication',
      'MONITOR_ENABLED'
    ])
  })

  test('state signing needs its own sufficiently long secret', () => {
    for (const value of ['short', configured.CRON_SECRET]) {
      expect(
        checkEnvironment({ ...configured, STATE_SIGNING_SECRET: value }).find(
          (check) => check.name === 'State signing'
        )?.ok
      ).toBe(false)
    }
  })
})


test('invalid credential status never includes the supplied values', () => {
  const secret = 'invalid-private-key-must-stay-private'
  const checks = checkEnvironment({ ...configured, GITHUB_APP_PRIVATE_KEY: secret })
  expect(checks.find((check) => check.name === 'GitHub signing key')?.ok).toBe(false)
  expect(JSON.stringify(checks)).not.toContain(secret)
})
