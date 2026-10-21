import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectRelatedSentryTelemetry } from '../../telemetry/sentry-related'
import { repository, project, end, start, incident, reply, mockFetch, nextLink } from '../fixtures/telemetry'

test('related telemetry is scoped, bounded and redacted before reaching the fixer', async () => {
  const traceId = '1'.repeat(32)
  const windowStart = '2026-10-21T03:30:00.000Z'
  const row = {
    id: '2'.repeat(16),
    timestamp: '2026-10-21T03:45:00.000Z',
    'project.id': project.id,
    environment: 'production',
    trace: traceId,
    parent_span: '3'.repeat(16),
    'span.op': 'http.client',
    'span.description':
      'GET https://private:password@example.com/send?token=hidden',
    'span.status': 'internal_error',
    'span.duration': 321,
    severity: 'error',
    message: 'secret-test user@example.com Bearer hidden',
    'user.email': 'private@example.com',
    cookies: 'do-not-publish'
  }
  let calls = 0
  const result = await collectRelatedSentryTelemetry(repository, traceId, {
    start: windowStart,
    end,
    token: 'secret-test',
    fetch: mockFetch((url, init) => {
      calls++
      assert.equal(init?.method, 'GET')
      assert.equal(url.pathname, `/api/0/organizations/${project.org}/events/`)
      assert.equal(url.searchParams.get('project'), project.id)
      assert.deepEqual(url.searchParams.getAll('environment'), ['production'])
      assert.equal(url.searchParams.get('start'), windowStart)
      assert.equal(url.searchParams.get('end'), end)
      assert.equal(url.searchParams.get('query'), `trace:${traceId}`)
      assert.equal(url.searchParams.get('per_page'), '50')
      assert.ok(url.searchParams.getAll('field').length <= 20)
      return reply({
        data: [
          row,
          { ...row, 'project.id': 'other-project' },
          { ...row, environment: 'preview' },
          { ...row, trace: '4'.repeat(32) },
          { ...row, timestamp: start },
          { ...row, environment: undefined }
        ]
      })
    })
  })
  assert.equal(calls, 2)
  assert.equal(result.spans.status, 'observed')
  assert.equal(result.spans.rows.length, 1)
  assert.equal(result.logs.rows.length, 1)
  assert.equal(result.spans.rows[0]?.durationMs, 321)
  assert.equal(
    result.spans.rows[0]?.description,
    'GET https://example.com/send'
  )
  assert.equal(
    result.logs.rows[0]?.message,
    '[redacted] [email] Bearer [redacted]'
  )
  assert.equal(result.spans.totalRows, null)
  assert.equal(result.logs.complete, false)
  const published = JSON.stringify(result)
  for (const secret of [
    'secret-test',
    'user@example.com',
    'private@example.com',
    'do-not-publish',
    'token=hidden'
  ])
    assert.ok(!published.includes(secret))
  assert.ok(result.limitations.some((value) => value.includes('discarded')))
})

test('empty and unavailable telemetry stay unknown and datasets fail independently', async () => {
  const result = await collectRelatedSentryTelemetry(repository, undefined, {
    start: '2026-10-21T03:30:00.000Z',
    end,
    token: 'test',
    fetch: mockFetch((url) =>
      url.searchParams.get('dataset') === 'spans'
        ? new Response('private response body', { status: 403 })
        : reply({ data: [] })
    )
  })
  assert.equal(result.correlation, 'time-window-only')
  assert.equal(result.spans.status, 'unavailable')
  assert.equal(result.logs.status, 'not-observed')
  assert.equal(result.logs.totalRows, null)
  assert.equal(result.logs.complete, false)
  assert.match(result.errors[0]!, /HTTP 403; related spans unavailable/)
  assert.ok(!JSON.stringify(result).includes('private response body'))
  assert.ok(
    result.limitations.some((value) =>
      value.includes('correlation with this incident is unknown')
    )
  )
  assert.ok(
    result.limitations.some((value) =>
      value.includes('Empty samples do not establish')
    )
  )
})

test('related telemetry rejects an unregistered project, injected trace and oversized window without requests', async () => {
  for (const options of [
    {
      project: 'unregistered',
      trace: undefined,
      start: '2026-10-21T03:30:00.000Z'
    },
    {
      project: project.slug,
      trace: 'invalid OR project:-1',
      start: '2026-10-21T03:30:00.000Z'
    },
    { project: project.slug, trace: undefined, start }
  ]) {
    const result = await collectRelatedSentryTelemetry(
      repository,
      options.trace,
      {
        ...options,
        end,
        token: 'test',
        fetch: mockFetch(() => {
          throw new Error('must not fetch')
        })
      }
    )
    assert.equal(result.spans.status, 'unavailable')
    assert.match(result.errors[0]!, /invalid related-telemetry scope/)
  }
})

test('related telemetry stops after one 50-row page per dataset and marks unknown coverage', async () => {
  let calls = 0
  const result = await collectRelatedSentryTelemetry(repository, undefined, {
    start: '2026-10-21T03:30:00.000Z',
    end,
    token: 'test',
    fetch: mockFetch((url) => {
      calls++
      assert.equal(url.searchParams.has('query'), false)
      return reply(
        {
          data: Array.from({ length: 60 }, (_, index) => ({
            id: String(index),
            timestamp: '2026-10-21T03:45:00.000Z',
            'project.id': project.id,
            environment: 'production',
            trace: null
          }))
        },
        { link: nextLink(url, 'unread-page') }
      )
    })
  })
  assert.equal(calls, 2)
  assert.equal(result.spans.rows.length, 50)
  assert.equal(result.logs.rows.length, 50)
  assert.equal(result.spans.limitReached, true)
  assert.equal(result.spans.complete, false)
  assert.equal(result.spans.totalRows, null)
})
