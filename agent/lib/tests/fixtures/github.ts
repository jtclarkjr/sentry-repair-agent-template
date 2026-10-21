import assert from 'node:assert/strict'
import { GitHubClient } from '../../github/client'
import type { IncidentMarker } from '../../github/state'
import { repositories } from '../../registry'

export const repository = repositories[0]!
export const project = repository.projects[0]!
export const root = `/repos/${repository.owner}/${repository.repo}`
export const baseSha = 'a'.repeat(40)
export const marker: IncidentMarker = {
  version: 1,
  issueId: '123',
  project: project.slug,
  repository: `${repository.owner}/${repository.repo}`,
  org: project.org,
  status: 'queued',
  releaseKey: 'release',
  lastSeen: '2026-10-21T04:00:00Z',
  attempts: 0,
  priority: 'P2'
}

export class TestClient extends GitHubClient {
  override async installationToken() {
    return 'synthetic-installation-token'
  }
}
export const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status })
export const mock = (
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>
) =>
  ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(new URL(String(input)), init))) as typeof fetch

export function reportServer() {
  const state = {
    rows: [] as any[],
    refs: new Map<string, string>(),
    commits: new Map<string, any>(),
    posts: 0,
    patches: 0,
    listReads: 0,
    invisibleLists: 0,
    hideList: false,
    losePostResponse: false,
    failBeforePost: false
  }
  const fetch = mock((url, init) => {
    const method = init?.method ?? 'GET'
    const path = url.pathname
    const body = init?.body ? JSON.parse(String(init.body)) : undefined
    if (method === 'GET' && path === root)
      return reply({ default_branch: 'main' })
    if (path === `${root}/branches/main`)
      return reply({ commit: { sha: baseSha } })
    if (path.startsWith(`${root}/git/ref/tags/`)) {
      const sha = state.refs.get(path.split('/').at(-1)!)
      return sha ? reply({ object: { type: 'commit', sha } }) : reply({}, 404)
    }
    if (path === `${root}/git/commits/${baseSha}`)
      return reply({ tree: { sha: 'base-tree' } })
    if (method === 'GET' && path.startsWith(`${root}/git/commits/`))
      return reply(state.commits.get(path.split('/').at(-1)!))
    if (method === 'POST' && path === `${root}/git/commits`) {
      const sha = 'c'.repeat(39) + String(state.commits.size + 1)
      state.commits.set(sha, body)
      return reply({ sha })
    }
    if (method === 'POST' && path === `${root}/git/refs`) {
      const name = body.ref.split('/').at(-1)
      if (state.refs.has(name)) return reply({}, 422)
      state.refs.set(name, body.sha)
      return reply({ object: { type: 'commit', sha: body.sha } })
    }
    if (method === 'GET' && path === `${root}/issues`) {
      state.listReads++
      if (state.hideList || state.invisibleLists-- > 0) return reply([])
      return reply(state.rows)
    }
    if (method === 'POST' && path === `${root}/issues`) {
      state.posts++
      if (state.failBeforePost)
        throw new Error('connection ended before POST arrived')
      const row = {
        number: 7,
        html_url: 'https://github.com/example/issues/7',
        body: body.body
      }
      state.rows.push(row)
      if (state.losePostResponse) throw new Error('ambiguous create')
      return reply(row)
    }
    if (path === `${root}/issues/7`) {
      if (!state.rows[0]) return reply({}, 404)
      if (method === 'PATCH') {
        state.patches++
        state.rows[0].body = body.body
      }
      return reply(state.rows[0])
    }
    throw new Error(`Unexpected report request: ${method} ${path}`)
  })
  return { state, client: () => new TestClient(fetch) }
}

export function publicationServer() {
  const state = {
    branch: '',
    ref: '',
    commits: new Map<string, any>(),
    pulls: [] as any[],
    createdRefs: 0,
    createdCommits: 0,
    createdPulls: 0,
    loseRefResponse: false,
    losePullResponse: false,
    failPullBeforeCreate: false,
    calls: [] as string[],
    defaultBase: baseSha
  }
  const client = new TestClient(
    mock((url, init) => {
      const path = url.pathname
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      state.calls.push(`${method} ${path}`)
      assert.equal(init?.redirect, 'error')
      if (path === root && method === 'GET')
        return reply({ default_branch: 'main' })
      if (path === `${root}/branches/main`)
        return reply({ commit: { sha: state.defaultBase } })
      if (path.startsWith(`${root}/git/matching-refs/heads/branch/incident-`))
        return reply(
          state.branch
            ? [
                {
                  ref: `refs/heads/${state.branch}`,
                  object: { sha: state.ref, type: 'commit' }
                }
              ]
            : []
        )
      if (path === `${root}/git/commits/${baseSha}`)
        return reply({ tree: { sha: 'base-tree' } })
      if (path === `${root}/git/trees` && method === 'POST')
        return reply({ sha: 'verified-tree' })
      if (path === `${root}/git/commits` && method === 'POST') {
        state.createdCommits++
        const next = 'c'.repeat(39) + state.createdCommits
        state.commits.set(next, {
          message: body.message,
          parents: [{ sha: baseSha }],
          tree: { sha: body.tree }
        })
        return reply({ sha: next })
      }
      if (path.startsWith(`${root}/git/commits/`) && method === 'GET')
        return reply(state.commits.get(path.split('/').at(-1)!))
      if (path.startsWith(`${root}/git/ref/heads/`) && method === 'GET')
        return state.ref
          ? reply({ object: { sha: state.ref } })
          : reply({}, 404)
      if (path === `${root}/git/refs` && method === 'POST') {
        if (state.ref) return reply({}, 422)
        state.branch = body.ref.replace('refs/heads/', '')
        state.ref = body.sha
        state.createdRefs++
        if (state.loseRefResponse) {
          state.loseRefResponse = false
          throw new Error('connection ended')
        }
        return reply({ object: { sha: state.ref } })
      }
      if (path === `${root}/pulls` && method === 'GET')
        return reply(state.pulls)
      if (path === `${root}/pulls` && method === 'POST') {
        if (state.failPullBeforeCreate)
          throw new Error('connection ended before publication')
        state.createdPulls++
        const pr = {
          state: 'open',
          draft: false,
          html_url: `https://github.com/${repository.owner}/${repository.repo}/pull/1`,
          body: body.body,
          head: {
            ref: body.head,
            sha: state.ref,
            repo: { full_name: `${repository.owner}/${repository.repo}` }
          },
          base: { ref: body.base }
        }
        state.pulls.push(pr)
        if (state.losePullResponse) {
          state.losePullResponse = false
          throw new Error('connection ended')
        }
        return reply(pr)
      }
      throw new Error(`Unmocked GitHub operation: ${method} ${path}`)
    })
  )
  return { state, client }
}

export function leaseServer() {
  const state = {
    ref: '',
    commits: new Map<string, any>(),
    createdRefs: 0,
    deletedRefs: 0,
    createdCommits: 0,
    loseRefResponse: false,
    loseDeleteResponse: false
  }
  const client = new TestClient(
    mock((url, init) => {
      const path = url.pathname
      const method = init?.method ?? 'GET'
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      if (
        method === 'GET' &&
        path === `${root}/git/ref/tags/incident-agent-lock`
      )
        return state.ref
          ? reply({ object: { sha: state.ref, type: 'commit' } })
          : reply({}, 404)
      if (method === 'GET' && path === `${root}/git/commits/${baseSha}`)
        return reply({ tree: { sha: 'b'.repeat(40) } })
      if (method === 'GET' && path.startsWith(`${root}/git/commits/`))
        return reply(state.commits.get(path.split('/').at(-1)!))
      if (method === 'POST' && path === `${root}/git/commits`) {
        state.createdCommits++
        const sha = 'c'.repeat(39) + state.createdCommits
        state.commits.set(sha, {
          message: body.message,
          tree: { sha: body.tree },
          parents: body.parents.map((sha: string) => ({ sha }))
        })
        return reply({ sha })
      }
      if (method === 'POST' && path === `${root}/git/refs`) {
        assert.equal(body.ref, 'refs/tags/incident-agent-lock')
        if (state.ref) return reply({}, 422)
        state.ref = body.sha
        state.createdRefs++
        if (state.loseRefResponse) {
          state.loseRefResponse = false
          throw new Error('ambiguous lock acquisition')
        }
        return reply({ object: { sha: state.ref } })
      }
      if (
        method === 'DELETE' &&
        path === `${root}/git/refs/tags/incident-agent-lock`
      ) {
        state.deletedRefs++
        state.ref = ''
        if (state.loseDeleteResponse) {
          state.loseDeleteResponse = false
          throw new Error('ambiguous lock release')
        }
        return new Response(null, { status: 204 })
      }
      throw new Error(`Unexpected lease operation: ${method} ${path}`)
    })
  )
  return { state, client }
}
