import { test } from 'node:test'
import assert from 'node:assert/strict'
import { reports, upsertReport } from '../../github/reports'
import { decodeMarker, encodeMarker } from '../../github/state'
import {
  repository,
  root,
  marker,
  TestClient,
  reply,
  mock,
  reportServer
} from '../fixtures/github'

test('report scans reject cross-repository markers and duplicated signed state', async () => {
  process.env.STATE_SIGNING_SECRET ??= 'synthetic-marker-signing-key'
  let rows = [
    {
      number: 1,
      html_url: 'https://github.com/example/issues/1',
      body: encodeMarker({ ...marker, repository: 'elsewhere/repository' })
    }
  ]
  const client = new TestClient(mock(() => reply(rows)))
  assert.deepEqual(await reports(client, repository), [])
  const signed = encodeMarker(marker)
  rows = [1, 2].map((number) => ({
    number,
    html_url: `https://github.com/example/issues/${number}`,
    body: signed
  }))
  await assert.rejects(
    reports(client, repository),
    /Duplicate signed incident reports/
  )
})

test('Cron rotation preserves state while a wrong signing key refuses duplicate-prone scans', async () => {
  const signing = process.env.STATE_SIGNING_SECRET
  const cron = process.env.CRON_SECRET
  process.env.STATE_SIGNING_SECRET = 'stable-state-signing-key'
  process.env.CRON_SECRET = 'old-cron-authentication'
  try {
    const body = encodeMarker(marker)
    process.env.CRON_SECRET = 'new-cron-authentication'
    assert.deepEqual(decodeMarker(body), marker)
    const client = new TestClient(
      mock(() =>
        reply([
          { number: 1, body, html_url: 'https://github.com/example/issues/1' }
        ])
      )
    )
    assert.equal((await reports(client, repository)).length, 1)
    process.env.STATE_SIGNING_SECRET = 'wrong-state-signing-key'
    await assert.rejects(
      reports(client, repository),
      /Signed report state cannot be authenticated/
    )
  } finally {
    if (signing === undefined) delete process.env.STATE_SIGNING_SECRET
    else process.env.STATE_SIGNING_SECRET = signing
    if (cron === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = cron
  }
})

test('report creation injects repository scope and reconciles before retrying creation', async () => {
  process.env.STATE_SIGNING_SECRET ??= 'synthetic-marker-signing-key'
  const server = reportServer()
  server.state.losePostResponse = true
  const result = await upsertReport(server.client(), repository, 'Incident', 'safe report', marker)
  assert.equal(server.state.posts, 1)
  assert.equal(server.state.patches, 1)
  assert.equal(
    server.state.refs.size,
    1,
    'creation intent remains after success'
  )
  assert.equal(
    result.marker.repository,
    `${repository.owner}/${repository.repo}`
  )
  assert.equal(result.number, 7)
})

test('a crash after successful creation cannot POST again while issue listings remain stale', async () => {
  process.env.STATE_SIGNING_SECRET ??= 'synthetic-marker-signing-key'
  const server = reportServer()
  await upsertReport(server.client(), repository, 'Incident', 'initial report', marker)
  server.state.hideList = true
  await assert.rejects(
    upsertReport(server.client(), repository, 'Incident', 'retry', marker),
    /creation is reserved/
  )
  assert.equal(server.state.posts, 1)
  assert.equal(server.state.rows.length, 1)
  assert.equal(server.state.refs.size, 1)
  const updated = await upsertReport(server.client(), repository, 'Incident', 'known-ID update', marker, 7)
  assert.equal(updated.number, 7)
  assert.equal(server.state.patches, 1)
})

test('simultaneous report creators share one atomic permanent intent and create at most one issue', async () => {
  process.env.STATE_SIGNING_SECRET ??= 'synthetic-marker-signing-key'
  const server = reportServer()
  await Promise.allSettled([
    upsertReport(server.client(), repository, 'Incident', 'report', marker),
    upsertReport(server.client(), repository, 'Incident', 'report', marker)
  ])
  assert.equal(server.state.posts, 1)
  assert.equal(server.state.rows.length, 1)
  assert.equal(server.state.refs.size, 1)
})

test('ambiguous creation remains bounded and cannot retry POST from a new client', async () => {
  process.env.STATE_SIGNING_SECRET ??= 'synthetic-marker-signing-key'
  const server = reportServer()
  server.state.losePostResponse = true
  server.state.hideList = true
  await assert.rejects(
    upsertReport(server.client(), repository, 'Incident', 'report', marker),
    /outcome is unknown/
  )
  assert.equal(server.state.listReads, 4)
  await assert.rejects(
    upsertReport(server.client(), repository, 'Incident', 'retry', marker),
    /creation is reserved/
  )
  assert.equal(server.state.listReads, 8)
  assert.equal(server.state.posts, 1)
  server.state.hideList = false
  assert.equal(
    (
      await upsertReport(server.client(), repository, 'Incident', 'reconciled', marker)
    ).number,
    7
  )
  assert.equal(server.state.posts, 1)
})

test('a reserved POST that never arrived requires manual recovery and invalid intent is refused', async () => {
  process.env.STATE_SIGNING_SECRET ??= 'synthetic-marker-signing-key'
  const server = reportServer()
  server.state.failBeforePost = true
  await assert.rejects(
    upsertReport(server.client(), repository, 'Incident', 'report', marker),
    /outcome is unknown/
  )
  server.state.failBeforePost = false
  await assert.rejects(
    upsertReport(server.client(), repository, 'Incident', 'retry', marker),
    /creation is reserved/
  )
  assert.equal(server.state.posts, 1)
  // Alter the authenticated payload itself, rather than unrelated prose.
  for (const commit of server.state.commits.values())
    commit.message = commit.message.replace(
      'sentry-repair-report-intent:',
      'sentry-repair-report-intent:X'
    )
  await assert.rejects(
    upsertReport(server.client(), repository, 'Incident', 'retry', marker),
    /reservation signature is invalid/
  )
  assert.equal(server.state.posts, 1)
})

test('known report updates validate the signed issue directly without a listing or create', async () => {
  process.env.STATE_SIGNING_SECRET ??= 'synthetic-marker-signing-key'
  const calls: string[] = []
  const client = new TestClient(
    mock((url, init) => {
      const method = init?.method ?? 'GET'
      calls.push(`${method} ${url.pathname}`)
      assert.equal(url.pathname, `${root}/issues/7`)
      return reply({
        number: 7,
        html_url: 'https://github.com/example/issues/7',
        body: encodeMarker(marker)
      })
    })
  )
  const updated = await upsertReport(
    client,
    repository,
    'Incident',
    'updated report',
    { ...marker, status: 'investigating' },
    7
  )
  assert.equal(updated.number, 7)
  assert.deepEqual(calls, [`GET ${root}/issues/7`, `PATCH ${root}/issues/7`])
})

test('known report IDs fail closed on missing or mismatched signed ownership', async () => {
  process.env.STATE_SIGNING_SECRET ??= 'synthetic-marker-signing-key'
  for (const body of [
    '',
    encodeMarker({ ...marker, issueId: 'other' }),
    encodeMarker({ ...marker, repository: 'other/repo' })
  ]) {
    const client = new TestClient(
      mock((_url, init) => {
        assert.equal(init?.method, 'GET')
        return reply({ number: 7, body })
      })
    )
    await assert.rejects(
      upsertReport(client, repository, 'Incident', 'report', marker, 7),
      /ownership could not be authenticated/
    )
  }
  const missing = new TestClient(mock(() => reply({}, 404)))
  await assert.rejects(
    upsertReport(missing, repository, 'Incident', 'report', marker, 7),
    /GitHub GET failed \(404\)/
  )
})
