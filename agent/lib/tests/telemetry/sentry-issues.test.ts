import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inspectSentryIssue, pollSentryIssues } from '../../telemetry/sentry-issues'
import { repositories } from '../../registry'
import { repository, project, end, start, releaseSha, issue, incident, event, reply, mockFetch, nextLink } from '../fixtures/telemetry'

test('initial projects poll only their registered production environment', async () => {
  for (const repo of repositories) {
    const result = await pollSentryIssues(repo, {
      end,
      token: 'test',
      fetch: mockFetch((url) => {
        // Sentry returns 404 if any requested environment name does not exist.
        const environments = url.searchParams.getAll('environment')
        return environments.length === 1 && environments[0] === 'production'
          ? reply([])
          : new Response(null, { status: 404 })
      })
    })
    assert.equal(
      result.complete,
      true,
      `${repo.id}: unsupported environment prevents reconciliation`
    )
    assert.deepEqual(result.errors, [])
  }
})

test('anonymous null user IDs preserve the event and leave affected users unknown', async () => {
  const anonymous = { ...event('anonymous-event', 5), user: { id: null } }
  const result = await inspectSentryIssue(repository, incident, {
    end,
    token: 'test',
    fetch: mockFetch((url) =>
      url.pathname.endsWith('/latest/') ? reply(anonymous) : reply([anonymous])
    )
  })
  assert.deepEqual(result.errors, [])
  assert.equal(result.details?.eventId, 'anonymous-event')
  for (const name of ['15m', '1h', '24h'] as const) {
    assert.equal(result.incident.volume[name].events, 1)
    assert.equal(result.incident.volume[name].affectedUsers, null)
  }
})

test('polls a fixed production-only 24h window, paginates and deduplicates issue IDs', async () => {
  const calls: URL[] = []
  const result = await pollSentryIssues(repository, {
    end,
    token: 'fake-test-token',
    fetch: mockFetch((url, init) => {
      calls.push(url)
      assert.equal(init?.method, 'GET')
      assert.equal(url.origin, 'https://sentry.io')
      assert.equal(url.searchParams.get('start'), start)
      assert.equal(url.searchParams.get('end'), end)
      assert.deepEqual(
        url.searchParams.getAll('environment'),
        repository.environments
      )
      assert.equal(url.searchParams.get('project'), project.id)
      assert.equal(
        url.searchParams.get('query'),
        'is:unresolved issue.category:error'
      )
      if (!url.searchParams.has('cursor'))
        return reply([issue(), issue('124', 'preview')], {
          link: nextLink(url, 'page-2')
        })
      return reply([issue(), issue('125')])
    })
  })
  assert.equal(calls.length, 2)
  assert.deepEqual(
    result.incidents.map((value) => value.issueId),
    ['123', '125']
  )
  assert.equal(result.incidents[0]?.title, 'Request failed for [email]')
  assert.equal(result.incidents[0]?.volume['24h'].events, null)
  assert.equal(result.complete, true)
  assert.equal(result.nextCursor, null)
})

test('bounded polling returns a resumable cursor and retains the original window', async () => {
  let page = 0
  const result = await pollSentryIssues(repository, {
    start,
    end,
    cursor: 'initial',
    token: 'test',
    fetch: mockFetch((url) => {
      page++
      return reply([issue(String(page))], { link: nextLink(url, String(page)) })
    })
  })
  assert.equal(page, 4)
  assert.equal(result.complete, false)
  assert.equal(result.nextCursor, '4')
  assert.equal(result.start, start)
  assert.equal(result.end, end)
})

test('does not follow cross-origin pagination or echo authentication error bodies', async () => {
  const unauthorized = await pollSentryIssues(repository, {
    end,
    token: 'top-secret',
    fetch: mockFetch(
      () => new Response('top-secret private@example.com', { status: 403 })
    )
  })
  assert.deepEqual(unauthorized.errors, ['Sentry: HTTP 403'])
  assert.equal(unauthorized.complete, false)
  let requests = 0
  const malicious = await pollSentryIssues(repository, {
    end,
    token: 'top-secret',
    fetch: mockFetch(() => {
      requests++
      return reply([issue()], {
        link: '<https://evil.example/api?cursor=stolen>; rel="next"; results="true"'
      })
    })
  })
  assert.equal(requests, 1)
  assert.deepEqual(malicious.errors, ['Sentry: invalid pagination target'])
  assert.equal(JSON.stringify(unauthorized).includes('top-secret'), false)
})

test('computes exact window volumes from complete production events and keeps unidentified users unknown', async () => {
  const latest = {
    ...event('one', 5, 'customer-42'),
    entries: [
      {
        type: 'exception',
        data: {
          values: [
            {
              type: 'TypeError',
              value:
                'Failed https://example.com/api?token=secret for private@example.com',
              stacktrace: {
                frames: [
                  {
                    filename: 'src/api.ts?token=secret',
                    function: 'load',
                    lineNo: 42,
                    colNo: 3,
                    inApp: true,
                    vars: { password: 'do-not-leak' }
                  }
                ]
              }
            }
          ]
        }
      },
      {
        type: 'breadcrumbs',
        data: {
          values: [
            {
              category: 'xhr',
              message: 'Authorization: Bearer private-value',
              data: {
                url: '/api?secret=hidden',
                method: 'GET',
                status_code: 503,
                body: 'do-not-leak'
              }
            }
          ]
        }
      },
      {
        type: 'request',
        data: { headers: [['Cookie', 'do-not-leak']], body: 'do-not-leak' }
      }
    ],
    contexts: {
      trace: { trace_id: 'b'.repeat(32), span_id: 'c'.repeat(16), op: 'http' },
      custom: { secret: 'do-not-leak' }
    },
    release: { version: releaseSha }
  }
  const result = await inspectSentryIssue(repository, incident, {
    end,
    token: 'test',
    fetch: mockFetch((url) => {
      if (url.pathname.endsWith('/latest/')) return reply(latest)
      if (!url.searchParams.has('cursor'))
        return reply(
          [event('one', 5, 'customer-42'), event('two', 20, 'customer-42')],
          { link: nextLink(url, 'next') }
        )
      return reply([
        event('one', 5, 'customer-42'),
        event('three', 50),
        event('preview', 5, null, 'preview')
      ])
    })
  })
  assert.deepEqual(result.incident.volume['15m'], {
    events: 1,
    affectedUsers: 1
  })
  assert.equal(result.incident.volumeObservedAt, end)
  assert.deepEqual(result.incident.volume.previous15m, {
    events: 1,
    affectedUsers: 1
  })
  assert.deepEqual(result.incident.volume['1h'], {
    events: 3,
    affectedUsers: null
  })
  assert.equal(result.incident.releaseSha, releaseSha)
  assert.equal(result.details?.exceptions[0]?.frames[0]?.line, 42)
  assert.equal(result.details?.trace.traceId, 'b'.repeat(32))
  const output = JSON.stringify(result)
  for (const sensitive of [
    'do-not-leak',
    'private@example.com',
    '?token=',
    'customer-42',
    'private-value',
    '?secret='
  ])
    assert.equal(output.includes(sensitive), false)
})

test('truncated event pagination never reports sampled volume as exact', async () => {
  let pages = 0
  const result = await inspectSentryIssue(repository, incident, {
    end,
    token: 'test',
    fetch: mockFetch((url) => {
      if (url.pathname.endsWith('/latest/')) return reply(event('latest', 5))
      if (
        url.pathname.endsWith('/events/') &&
        !url.pathname.includes('/issues/')
      )
        return new Response('No org scope', { status: 403 })
      pages++
      return reply([event(String(pages), 5)], {
        link: nextLink(url, String(pages))
      })
    })
  })
  assert.equal(pages, 5)
  assert.deepEqual(result.incident.volume['24h'], {
    events: null,
    affectedUsers: null
  })
  assert.match(result.errors.join(), /pagination incomplete/)
})

test('high-volume incidents use scoped server aggregates instead of sampled counts', async () => {
  let pages = 0
  let aggregates = 0
  const result = await inspectSentryIssue(repository, incident, {
    end,
    token: 'test',
    fetch: mockFetch((url) => {
      if (url.pathname.endsWith('/latest/')) return reply(event('latest', 5))
      if (
        url.pathname.endsWith('/events/') &&
        !url.pathname.includes('/issues/')
      ) {
        aggregates++
        assert.equal(url.searchParams.get('dataset'), 'errors')
        assert.equal(url.searchParams.get('query'), 'issue.id:123')
        assert.equal(url.searchParams.get('project'), project.id)
        assert.deepEqual(
          url.searchParams.getAll('environment'),
          repository.environments
        )
        assert.deepEqual(url.searchParams.getAll('field'), [
          'count()',
          'count_unique(user)'
        ])
        return reply({ data: [{ 'count()': 1001, 'count_unique(user)': 0 }] })
      }
      pages++
      return reply([event(String(pages), 5)], {
        link: nextLink(url, String(pages))
      })
    })
  })
  assert.equal(aggregates, 4)
  assert.deepEqual(result.incident.volume['24h'], {
    events: 1001,
    affectedUsers: null
  })
})

test('unidentified event environments do not turn into zero production errors', async () => {
  const result = await inspectSentryIssue(repository, incident, {
    end,
    token: 'test',
    fetch: mockFetch((url) => {
      if (url.pathname.endsWith('/latest/')) return reply(event('latest', 5))
      if (!url.pathname.includes('/issues/'))
        return new Response('', { status: 403 })
      return reply([{ ...event('unknown', 5), tags: [] }])
    })
  })
  assert.equal(result.incident.volume['24h'].events, null)
  assert.match(result.errors.join(), /environment unknown/)
})

test('rejects preview latest events and does not infer an environment or a commit', async () => {
  const result = await inspectSentryIssue(
    repository,
    { ...incident, environment: null },
    {
      end,
      token: 'test',
      fetch: mockFetch((url) =>
        url.pathname.endsWith('/latest/')
          ? reply({
              ...event('latest', 5, null, 'preview'),
              release: { version: releaseSha }
            })
          : reply([])
      )
    }
  )
  assert.equal(result.incident.environment, null)
  assert.equal(result.incident.releaseSha, undefined)
  assert.equal(result.details, null)
  assert.match(result.errors.join(), /outside configured production/)
  assert.equal(result.incident.volume['24h'].affectedUsers, null)
})
