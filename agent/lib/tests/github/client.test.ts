import { test } from 'node:test'
import assert from 'node:assert/strict'
import { repository, root, baseSha, TestClient, reply, mock } from '../fixtures/github'

test('source archive follows only the configured codeload redirect without forwarding auth', async () => {
  let downloads = 0
  const client = new TestClient(
    mock((url, init) => {
      if (url.pathname === root) return reply({ default_branch: 'main' })
      if (url.pathname === `${root}/branches/main`)
        return reply({ commit: { sha: baseSha } })
      if (url.pathname.startsWith(`${root}/tarball/`)) {
        assert.equal(init?.redirect, 'manual')
        assert.equal(new Headers(init?.headers).has('authorization'), true)
        return new Response(null, {
          status: 302,
          headers: {
            location: `https://codeload.github.com/${repository.owner}/${repository.repo}/legacy.tar.gz/${baseSha}`
          }
        })
      }
      downloads++
      assert.equal(url.origin, 'https://codeload.github.com')
      assert.equal(init?.headers, undefined)
      assert.equal(init?.redirect, 'error')
      return new Response('archive')
    })
  )
  assert.equal((await client.source(repository)).archive.toString(), 'archive')
  assert.equal(downloads, 1)
})

test('source redirects and oversized declared archives fail before unsafe downloads', async () => {
  for (const location of [
    'https://evil.example/archive',
    `https://codeload.github.com/other/repo/tar.gz/${baseSha}`,
    `https://user:secret@codeload.github.com/${repository.owner}/${repository.repo}/tar.gz/${baseSha}`
  ]) {
    let calls = 0
    const client = new TestClient(
      mock((url) => {
        calls++
        if (url.pathname === root) return reply({ default_branch: 'main' })
        if (url.pathname === `${root}/branches/main`)
          return reply({ commit: { sha: baseSha } })
        return new Response(null, { status: 302, headers: { location } })
      })
    )
    await assert.rejects(client.source(repository), /redirect outside/)
    assert.equal(calls, 3)
  }
  const client = new TestClient(
    mock((url) =>
      url.pathname === root
        ? reply({ default_branch: 'main' })
        : url.pathname.includes('/branches/')
          ? reply({ commit: { sha: baseSha } })
          : new Response('small', { headers: { 'content-length': '40000001' } })
    )
  )
  await assert.rejects(client.source(repository), /exceeds 40 MB/)
})

test('repository requests refuse origin and path traversal escapes', async () => {
  const client = new TestClient(
    mock(() => {
      throw new Error('unsafe request reached network')
    })
  )
  for (const path of [
    `${root}/../../other/repo/issues`,
    `${root}/%2e%2e/other/issues`,
    'https://evil.example/repos/example/repo/issues'
  ])
    await assert.rejects(
      client.request(repository, 'GET', path),
      /outside configured repository/
    )
})
