import { describe, expect, test } from 'bun:test'
import { requireMonitorOidc } from '../smoke'

const now = 1_800_000_000_000
const token = (claims: Record<string, unknown>) =>
  `header.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.signature`
const configured = {
  VERCEL_PROJECT_ID: 'prj_example-monitor',
  VERCEL_TEAM_ID: 'team_example',
  VERCEL_OIDC_TOKEN: token({
    project_id: 'prj_example-monitor',
    owner_id: 'team_example',
    exp: now / 1000 + 60
  })
}

describe('live smoke OIDC configuration', () => {
  test('accepts fresh claims for the explicitly configured project and team', () => {
    expect(() => requireMonitorOidc(configured, now)).not.toThrow()
  })

  test('requires project, team, and token', () => {
    for (const name of ['VERCEL_PROJECT_ID', 'VERCEL_TEAM_ID', 'VERCEL_OIDC_TOKEN']) {
      expect(() => requireMonitorOidc({ ...configured, [name]: '' }, now)).toThrow()
    }
  })

  test('rejects credentials from a different project or team', () => {
    for (const override of [
      { project_id: 'prj_other', owner_id: 'team_example' },
      { project_id: 'prj_example-monitor', owner_id: 'team_other' }
    ]) {
      expect(() => requireMonitorOidc({
        ...configured,
        VERCEL_OIDC_TOKEN: token({ ...override, exp: now / 1000 + 60 })
      }, now)).toThrow(/OIDC must belong/)
    }
  })

  test('rejects expired, missing, or nonnumeric expiry', () => {
    for (const exp of [now / 1000 - 1, now / 1000, undefined, '9999999999']) {
      expect(() => requireMonitorOidc({
        ...configured,
        VERCEL_OIDC_TOKEN: token({
          project_id: configured.VERCEL_PROJECT_ID,
          owner_id: configured.VERCEL_TEAM_ID,
          exp
        })
      }, now)).toThrow(/expiry|expired/)
    }
  })

  test('rejects API-key and access-token fallback', () => {
    for (const name of ['AI_GATEWAY_API_KEY', 'VERCEL_TOKEN']) {
      expect(() => requireMonitorOidc({ ...configured, [name]: 'test-fallback' }, now))
        .toThrow(/without an API-key or access-token fallback/)
    }
  })

  test('malformed claims produce a credential-safe error', () => {
    const secret = 'private-token-must-not-be-printed'
    try {
      requireMonitorOidc({ ...configured, VERCEL_OIDC_TOKEN: `header.${secret}.signature` }, now)
      throw new Error('Expected invalid claims to fail')
    } catch (error) {
      expect(String(error)).toContain('Invalid OIDC token claims')
      expect(String(error)).not.toContain(secret)
    }
  })
})
