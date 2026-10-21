import { test } from 'node:test'
import assert from 'node:assert/strict'
import { collectVercelEvidence } from '../../telemetry/vercel'
import { repository, end, start, releaseSha, incident, reply, mockFetch } from '../fixtures/telemetry'

test('Vercel production metadata and runtime samples are bounded, redacted, and explicitly incomplete', async () => {
  const log = {
    rowId: 'row',
    timestampInMs: Date.parse(end) - 60_000,
    level: 'error',
    source: 'serverless',
    message: 'failure for private@example.com Authorization: Bearer secret',
    requestPath: '/api/items?token=secret',
    requestMethod: 'GET',
    responseStatusCode: 500,
    messageTruncated: false
  }
  const result = await collectVercelEvidence(repository, {
    start,
    end,
    releaseSha,
    token: 'test-token',
    fetch: mockFetch((url, init) => {
      assert.equal(init?.method, 'GET')
      assert.equal(url.origin, 'https://api.vercel.com')
      if (url.pathname === '/v7/deployments') {
        assert.equal(url.searchParams.get('target'), 'production')
        assert.equal(
          url.searchParams.get('projectId'),
          repository.vercelProjectId
        )
        assert.equal(url.searchParams.get('sha'), releaseSha)
        return reply({
          deployments: [
            {
              uid: 'preview',
              projectId: repository.vercelProjectId,
              target: 'preview',
              created: Date.parse(start),
              url: null
            },
            {
              uid: 'dpl_prod',
              projectId: repository.vercelProjectId,
              target: 'production',
              created: Date.parse(start),
              url: 'deployment.vercel.app',
              state: 'READY',
              meta: { githubCommitSha: releaseSha, secret: 'do-not-leak' }
            }
          ]
        })
      }
      return new Response(`${JSON.stringify(log)}\n${JSON.stringify(log)}\n`, {
        headers: { 'content-type': 'application/x-ndjson' }
      })
    })
  })
  assert.equal(result.deployments.length, 1)
  assert.equal(result.logs.length, 1)
  assert.equal(result.historicalLogsComplete, false)
  assert.equal(result.logsCoverage, 'bounded-live-sample')
  assert.equal(result.logs[0]?.path, '/api/items')
  assert.match(result.errors.join(), /not complete incident-window history/)
  for (const sensitive of [
    'private@example.com',
    'Bearer secret',
    'do-not-leak',
    '?token=secret'
  ])
    assert.equal(JSON.stringify(result).includes(sensitive), false)
})
