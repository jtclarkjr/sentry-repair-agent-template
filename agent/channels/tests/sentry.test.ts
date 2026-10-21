import { afterEach, test } from 'bun:test'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import {
  SessionStrandedError,
  type ChannelResolveSession,
  type Session
} from 'eve/channels'
import channel, { hasActiveRepair } from '../sentry'
import { repositories } from '../../lib/registry'

const original = {
  monitor: process.env.MONITOR_ENABLED,
  cron: process.env.CRON_SECRET,
  sentry: process.env.SENTRY_WEBHOOK_SECRET
}
afterEach(() => {
  for (const [key, value] of Object.entries({
    MONITOR_ENABLED: original.monitor,
    CRON_SECRET: original.cron,
    SENTRY_WEBHOOK_SECRET: original.sentry
  })) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})
async function request(
  path: string,
  init?: RequestInit,
  resolveSession?: ChannelResolveSession
) {
  const routes = (
    channel as unknown as { routes: { path: string; handler: Function }[] }
  ).routes
  const route = routes.find((route) => route.path === path)!
  return route.handler(new Request(`https://agent.invalid${path}`, init), {
    resolveSession,
    from() {
      throw new Error('Disabled intake must not start an agent')
    }
  }) as Promise<Response>
}
function ownerWithTail(
  type?: string,
  liveFailure?: unknown
): ChannelResolveSession {
  return async () =>
    ({
      id: 'session-test',
      getEventStream(options: { follow?: boolean }) {
        if (options.follow) {
          assert.deepEqual(options, { startIndex: -1, follow: true })
          if (liveFailure) throw liveFailure
          return new ReadableStream()
        }
        assert.deepEqual(options, { startIndex: -1, follow: false })
        return new ReadableStream({
          start(controller) {
            if (type) controller.enqueue({ type })
            controller.close()
          }
        })
      }
    }) as unknown as Session
}
function signed(body: string, resource = 'issue') {
  process.env.SENTRY_WEBHOOK_SECRET = 'local-webhook-test-secret'
  return {
    method: 'POST',
    body,
    headers: {
      'sentry-hook-resource': resource,
      'sentry-hook-signature': createHmac(
        'sha256',
        process.env.SENTRY_WEBHOOK_SECRET
      )
        .update(body)
        .digest('hex')
    }
  }
}

test('disabled cron authenticates before acknowledging and never starts model work', async () => {
  process.env.MONITOR_ENABLED = 'false'
  process.env.CRON_SECRET = 'local-cron-test-secret'
  assert.equal((await request('/cron/reconcile')).status, 401)
  assert.equal(
    (
      await request('/cron/reconcile', {
        headers: { authorization: 'Bearer wrong' }
      })
    ).status,
    401
  )
  assert.deepEqual(
    await (
      await request('/cron/reconcile', {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }
      })
    ).json(),
    { skipped: 'monitoring-disabled' }
  )
})
test('only signed valid installation deliveries succeed while monitoring is disabled', async () => {
  process.env.MONITOR_ENABLED = 'false'
  assert.equal(
    (await request('/webhooks/sentry', { method: 'POST', body: '{}' })).status,
    401
  )
  assert.equal((await request('/webhooks/sentry', signed('{'))).status, 400)
  assert.equal((await request('/webhooks/sentry', signed('{}'))).status, 503)
  assert.deepEqual(
    await (
      await request('/webhooks/sentry', signed('{}', 'installation'))
    ).json(),
    { accepted: true, resource: 'installation' }
  )
})
test('HTTP webhook boundary rejects oversized unsigned bodies before parsing', async () => {
  assert.equal(
    (
      await request('/webhooks/sentry', {
        method: 'POST',
        body: '{}',
        headers: { 'content-length': '64001' }
      })
    ).status,
    413
  )
})

test('active and durable parked owners suppress wakes; settled owners permit crash recovery', async () => {
  for (const type of [
    'turn.started',
    'action.result',
    'turn.waiting',
    'step.started'
  ])
    assert.equal(await hasActiveRepair(ownerWithTail(type), 'repo:test'), true)
  for (const type of [
    'session.waiting',
    'turn.failed',
    'turn.cancelled',
    'turn.completed',
    'session.failed'
  ])
    assert.equal(await hasActiveRepair(ownerWithTail(type), 'repo:test'), false)
  assert.equal(await hasActiveRepair(async () => undefined, 'repo:test'), false)
})

test('cron does not enqueue coordinator work while repository turns remain active', async () => {
  process.env.MONITOR_ENABLED = 'true'
  process.env.CRON_SECRET = 'local-cron-test-secret'
  for (let tick = 0; tick < 3; tick++) {
    const response = await request(
      '/cron/reconcile',
      {
        headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }
      },
      ownerWithTail('turn.waiting')
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { scheduled: 0, unavailable: [] })
  }
})

test('duplicate signed Sentry deliveries do not enqueue a second active repair', async () => {
  process.env.MONITOR_ENABLED = 'true'
  const project = repositories[0]!.projects[0]!
  const payload = JSON.stringify({
    organization: project.org,
    data: { issue: { project: { id: project.id, slug: project.slug } } }
  })
  for (let delivery = 0; delivery < 2; delivery++) {
    const response = await request(
      '/webhooks/sentry',
      signed(payload),
      ownerWithTail('step.started')
    )
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), {
      accepted: true,
      changed: false,
      reason: 'repair-active'
    })
  }
})

test('an unreadable active owner fails closed instead of enqueueing another model call', async () => {
  process.env.MONITOR_ENABLED = 'true'
  process.env.CRON_SECRET = 'local-cron-test-secret'
  const response = await request(
    '/cron/reconcile',
    {
      headers: { authorization: `Bearer ${process.env.CRON_SECRET}` }
    },
    async () => {
      throw new Error('owner unavailable')
    }
  )
  assert.equal(response.status, 503)
  const result = await response.json()
  assert.equal(result.scheduled, 0)
  assert.deepEqual(
    result.unavailable,
    repositories.map((repo) => repo.id)
  )
  assert.ok(
    result.ownership.every(
      (owner: { reason: string; recovery: string }) =>
        owner.reason === 'owner-unavailable' &&
        /never steal a live repair lease/.test(owner.recovery)
    )
  )
})

test('a stranded nonterminal owner is visible as unavailable instead of silently active', async () => {
  process.env.MONITOR_ENABLED = 'true'
  process.env.CRON_SECRET = 'local-cron-test-secret'
  const resolve = ownerWithTail(
    'turn.waiting',
    new SessionStrandedError({ eveVersion: '0.79.0' })
  )
  const response = await request(
    '/cron/reconcile',
    { headers: { authorization: `Bearer ${process.env.CRON_SECRET}` } },
    resolve
  )
  assert.equal(response.status, 503)
  const result = await response.json()
  assert.equal(result.scheduled, 0)
  assert.deepEqual(
    result.unavailable,
    repositories.map((repo) => repo.id)
  )
  assert.ok(
    result.ownership.every(
      (owner: {
        reason: string
        sessionId: string
        eveVersion: string
        lastEventType: string
      }) =>
        owner.reason === 'session-stranded' &&
        owner.sessionId === 'session-test' &&
        owner.eveVersion === '0.79.0' &&
        owner.lastEventType === 'turn.waiting'
    )
  )
})

test('signed webhook returns retriable unavailable ownership and a recovery instruction', async () => {
  process.env.MONITOR_ENABLED = 'true'
  const project = repositories[0]!.projects[0]!
  const payload = JSON.stringify({
    organization: project.org,
    data: { issue: { project: { id: project.id, slug: project.slug } } }
  })
  const response = await request(
    '/webhooks/sentry',
    signed(payload),
    ownerWithTail('step.started', new SessionStrandedError({}))
  )
  assert.equal(response.status, 503)
  const result = await response.json()
  assert.equal(result.accepted, false)
  assert.equal(result.reason, 'repair-owner-unavailable')
  assert.equal(result.ownership.reason, 'session-stranded')
  assert.match(result.ownership.recovery, /confirming no repair is running/)
})

test('a live owner check detaches immediately without waiting for another event', async () => {
  let detached = false
  const resolve: ChannelResolveSession = async () =>
    ({
      id: 'live-owner',
      getEventStream({ follow }: { follow?: boolean }) {
        return follow
          ? new ReadableStream({
              cancel() {
                detached = true
              }
            })
          : new ReadableStream({
              start(controller) {
                controller.enqueue({
                  type: 'turn.waiting',
                  meta: { at: '2026-10-21T02:00:00Z' }
                })
                controller.close()
              }
            })
      }
    }) as unknown as Session
  assert.equal(await hasActiveRepair(resolve, 'repo:test'), true)
  assert.equal(detached, true)
})

test('an empty recorded owner history is unavailable and cannot suppress retries invisibly', async () => {
  await assert.rejects(
    hasActiveRepair(ownerWithTail(), 'repo:test'),
    (error: any) => error.details.reason === 'owner-history-empty'
  )
})

test('a stalled ownership read is bounded without sending or resetting the session', async () => {
  await assert.rejects(
    hasActiveRepair(async () => new Promise(() => {}), 'repo:test'),
    (error: any) => error.details.reason === 'owner-check-timeout'
  )
}, 10_000)
