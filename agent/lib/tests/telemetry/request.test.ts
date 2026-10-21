import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pollSentryIssues } from '../../telemetry/sentry-issues'
import { collectRelatedSentryTelemetry } from '../../telemetry/sentry-related'
import { collectVercelEvidence } from '../../telemetry/vercel'
import { repository, end, start, reply, mockFetch } from '../fixtures/telemetry'

test('missing credentials are explicit and do not trigger network calls', async () => {
  const fail = mockFetch(() => {
    throw new Error('network must not run')
  })
  assert.match(
    (
      await pollSentryIssues(repository, { token: '', fetch: fail })
    ).errors.join(),
    /SENTRY_AUTH_TOKEN missing/
  )
  assert.match(
    (
      await collectVercelEvidence(repository, {
        token: '',
        start,
        end,
        fetch: fail
      })
    ).errors.join(),
    /VERCEL_READ_TOKEN missing/
  )
  assert.match(
    (
      await collectRelatedSentryTelemetry(repository, undefined, {
        token: '',
        start: '2026-10-21T03:30:00.000Z',
        end,
        fetch: fail
      })
    ).errors.join(),
    /SENTRY_AUTH_TOKEN missing/
  )
})

test('an exhausted intake deadline fails closed without starting another request', async () => {
  let requests = 0
  const result = await pollSentryIssues(repository, {
    end,
    token: 'test',
    deadline: Date.now() - 1,
    fetch: mockFetch(() => {
      requests++
      return reply([])
    })
  })
  assert.equal(requests, 0)
  assert.equal(result.complete, false)
  assert.match(result.errors.join(), /reconciliation deadline reached/)
})
