import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evidenceForFixer, hasUpdates, prepareQueue, updateReport } from '../../incidents/queue'
import { encodeMarker, decodeMarker, type IncidentMarker } from '../../github/state'
import { GitHubClient } from '../../github/client'
import { repositories } from '../../registry'

const repository = repositories[0]!
const project = repository.projects[0]!
const repositoryRoot = `/repos/${repository.owner}/${repository.repo}`
const releaseSha = 'a'.repeat(40)
const baseSha = 'b'.repeat(40)
const response = (body: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { status, headers })

async function fixture(
  previous: Partial<IncidentMarker> | undefined,
  run: (state: {
    now: string
    lastSeen: string
    writes: string[]
    marker: () => IncidentMarker | null
    body: () => string
    sentryFailure: boolean
    latestFailure: boolean
    suppressRelease: boolean
    paginateForever: boolean
    issueCount: number
    cursors: string[]
    windows: string[]
    hideReportsFromList: boolean
  }) => Promise<void>
) {
  const originalFetch = globalThis.fetch
  const originalInstallationToken = GitHubClient.prototype.installationToken
  const originalSentry = process.env.SENTRY_AUTH_TOKEN
  const originalSigning = process.env.STATE_SIGNING_SECRET
  process.env.SENTRY_AUTH_TOKEN = 'synthetic-sentry-read-token'
  process.env.STATE_SIGNING_SECRET = 'synthetic-queue-signing-key'
  const now = new Date().toISOString()
  const lastSeen = new Date(Date.now() - 60_000).toISOString()
  const firstSeen = new Date(Date.now() - 3_600_000).toISOString()
  const initial: IncidentMarker = {
    version: 1,
    issueId: '123',
    project: project.slug,
    org: project.org,
    repository: `${repository.owner}/${repository.repo}`,
    releaseKey: releaseSha,
    lastSeen,
    attempts: 0,
    priority: 'P2',
    status: 'queued',
    ...previous
  }
  let reports: any[] = previous
    ? [
        {
          number: 7,
          html_url: 'https://github.com/example/issues/7',
          body: encodeMarker(initial)
        }
      ]
    : []
  const reportReservations = new Map<string, string>()
  const reservationCommits = new Map<string, unknown>()
  const state = {
    now,
    lastSeen,
    writes: [] as string[],
    marker: () => decodeMarker(reports[0]?.body ?? ''),
    body: () => reports[0]?.body ?? '',
    sentryFailure: false,
    latestFailure: false,
    suppressRelease: false,
    paginateForever: false,
    issueCount: 1,
    cursors: [] as string[],
    windows: [] as string[],
    hideReportsFromList: false
  }
  GitHubClient.prototype.installationToken = async () =>
    'synthetic-github-installation-token'
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const method = init?.method ?? 'GET'
    if (url.origin === 'https://sentry.io') {
      if (state.sentryFailure)
        return response({ detail: 'must not echo private response' }, 403)
      if (url.pathname.endsWith('/issues/')) {
        state.cursors.push(url.searchParams.get('cursor') ?? '')
        state.windows.push(
          `${url.searchParams.get('start')}/${url.searchParams.get('end')}`
        )
        const headers: Record<string, string> = {}
        if (state.paginateForever) {
          const next = new URL(url)
          next.searchParams.set(
            'cursor',
            String(Number(url.searchParams.get('cursor') ?? 0) + 1)
          )
          headers.link = `<${next}>; rel="next"; results="true"`
        }
        const offset = Number(url.searchParams.get('cursor') ?? 0)
        if (state.issueCount > 1 && offset + 25 < state.issueCount) {
          const next = new URL(url)
          next.searchParams.set('cursor', String(offset + 25))
          headers.link = `<${next}>; rel="next"; results="true"`
        }
        const rows = Array.from(
          { length: Math.max(0, Math.min(25, state.issueCount - offset)) },
          (_, index) => ({
            id: state.issueCount === 1 ? '123' : String(offset + index + 1),
            title: 'Application failure',
            firstSeen,
            lastSeen,
            project: { id: project.id, slug: project.slug },
            matchingEventEnvironment: 'production'
          })
        )
        return response(rows, 200, headers)
      }
      const event = {
        eventID: 'event-1',
        dateCreated: lastSeen,
        projectID: project.id,
        groupID: '123',
        environment: 'production',
        user: null,
        release: state.suppressRelease ? undefined : { version: releaseSha },
        entries: []
      }
      if (url.pathname.endsWith('/latest/'))
        return state.latestFailure ? response({}, 503) : response(event)
      if (url.pathname.endsWith('/events/')) return response([event])
      throw new Error('Unexpected Sentry operation in test')
    }
    assert.equal(url.origin, 'https://api.github.com')
    if (method !== 'GET') state.writes.push(`${method} ${url.pathname}`)
    if (url.pathname === repositoryRoot)
      return response({ default_branch: 'main' })
    if (url.pathname === `${repositoryRoot}/branches/main`)
      return response({ commit: { sha: baseSha } })
    if (
      url.pathname.startsWith(
        `${repositoryRoot}/git/ref/tags/incident-agent-report-`
      )
    ) {
      const sha = reportReservations.get(url.pathname.split('/').at(-1)!)
      return sha
        ? response({ object: { type: 'commit', sha } })
        : response({}, 404)
    }
    if (url.pathname === `${repositoryRoot}/git/commits/${baseSha}`)
      return response({ tree: { sha: 'base-tree' } })
    if (url.pathname.startsWith(`${repositoryRoot}/git/commits/`))
      return response(reservationCommits.get(url.pathname.split('/').at(-1)!))
    if (url.pathname === `${repositoryRoot}/git/commits` && method === 'POST') {
      const sha = 'c'.repeat(40)
      reservationCommits.set(sha, JSON.parse(String(init?.body)))
      return response({ sha })
    }
    if (url.pathname === `${repositoryRoot}/git/refs` && method === 'POST') {
      const body = JSON.parse(String(init?.body))
      reportReservations.set(body.ref.split('/').at(-1), body.sha)
      return response({ object: { type: 'commit', sha: body.sha } })
    }
    if (url.pathname === `${repositoryRoot}/issues` && method === 'GET')
      return response(state.hideReportsFromList ? [] : reports)
    if (url.pathname === `${repositoryRoot}/issues/7` && method === 'GET')
      return reports[0] ? response(reports[0]) : response({}, 404)
    if (
      url.pathname.startsWith(`${repositoryRoot}/issues`) &&
      method !== 'GET'
    ) {
      const body = JSON.parse(String(init?.body))
      reports = [
        {
          number: 7,
          html_url: 'https://github.com/example/issues/7',
          body: body.body
        }
      ]
      return response(reports[0])
    }
    throw new Error(
      `Unexpected GitHub operation in test: ${method} ${url.pathname}`
    )
  }) as typeof fetch
  try {
    await run(state)
  } finally {
    globalThis.fetch = originalFetch
    GitHubClient.prototype.installationToken = originalInstallationToken
    if (originalSentry === undefined) delete process.env.SENTRY_AUTH_TOKEN
    else process.env.SENTRY_AUTH_TOKEN = originalSentry
    if (originalSigning === undefined) delete process.env.STATE_SIGNING_SECRET
    else process.env.STATE_SIGNING_SECRET = originalSigning
  }
}

test('an update keeps the newly created report ID when GitHub listings lag', async () => {
  await fixture(undefined, async (state) => {
    const [job] = await prepareQueue(repository)
    assert.ok(job)
    assert.equal(job.report.number, 7)
    state.hideReportsFromList = true
    const updated = await updateReport(repository, job, {
      status: 'investigating',
      attempts: 1
    })
    assert.equal(updated.report.number, 7)
    assert.deepEqual(
      state.writes.filter((write) => write.includes('/issues')),
      [`POST ${repositoryRoot}/issues`, `PATCH ${repositoryRoot}/issues/7`]
    )
  })
})

test('fixer evidence collects trace-scoped spans and logs around the production event', async () => {
  await fixture(undefined, async (state) => {
    const [job] = await prepareQueue(repository)
    assert.ok(job)
    const traceId = '1'.repeat(32)
    job.details = { sentry: { timestamp: state.lastSeen, trace: { traceId } } }
    const originalVercel = process.env.VERCEL_READ_TOKEN
    process.env.VERCEL_READ_TOKEN = ''
    const calls: string[] = []
    globalThis.fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit
    ) => {
      const url = new URL(String(input))
      assert.equal(init?.method, 'GET')
      assert.equal(url.origin, 'https://sentry.io')
      assert.equal(url.searchParams.get('project'), project.id)
      assert.deepEqual(url.searchParams.getAll('environment'), ['production'])
      assert.equal(url.searchParams.get('query'), `trace:${traceId}`)
      assert.ok(
        Date.parse(url.searchParams.get('start')!) < Date.parse(state.lastSeen)
      )
      assert.ok(
        Date.parse(url.searchParams.get('end')!) > Date.parse(state.lastSeen)
      )
      calls.push(url.searchParams.get('dataset')!)
      return response({ data: [] })
    }) as typeof fetch
    try {
      const evidence = await evidenceForFixer(repository, job)
      assert.deepEqual(calls, ['spans', 'logs'])
      assert.equal(evidence.details.relatedSentry.correlation, 'trace')
      assert.equal(evidence.details.relatedSentry.spans.totalRows, null)
      assert.equal(evidence.details.relatedSentry.logs.complete, false)
      assert.match(
        evidence.details.vercel.errors.join(),
        /VERCEL_READ_TOKEN missing/
      )
    } finally {
      if (originalVercel === undefined) delete process.env.VERCEL_READ_TOKEN
      else process.env.VERCEL_READ_TOKEN = originalVercel
    }
  })
})

test('unchanged in-flight investigation and verification stages resume after interruption', async () => {
  for (const status of ['investigating', 'verified'] as const) {
    await fixture({ status, attempts: 1 }, async () => {
      assert.equal(await hasUpdates(repository), true)
      const queue = await prepareQueue(repository)
      assert.equal(queue.length, 1)
      assert.equal(queue[0]!.marker.attempts, 1)
      assert.equal(queue[0]!.baseSha, baseSha)
    })
  }
})

test('intake continues beyond 100 issue groups with the original fixed window and cursor', async () => {
  await fixture(undefined, async (state) => {
    state.issueCount = 101
    assert.equal(await hasUpdates(repository), true)
    assert.deepEqual(state.cursors, ['', '25', '50', '75', '100'])
    assert.equal(new Set(state.windows).size, 1)
    assert.equal(state.writes.length, 0)
  })
})

test('a new release resets stale impact, root-cause, retry count and old PR association', async () => {
  await fixture(
    {
      status: 'pr-open',
      attempts: 2,
      releaseKey: 'c'.repeat(40),
      lastSeen: '2026-01-01T00:00:00.000Z',
      priority: 'P0',
      flows: [
        {
          flowId: 'chat',
          impact: 'blocked',
          evidence: ['old-release outage'],
          systemWide: true,
          dataLoss: false
        }
      ],
      rootCause: {
        confidence: 'confirmed',
        summary: 'Old release diagnosis',
        evidence: ['old-release evidence'],
        unknowns: []
      },
      prUrl: 'https://github.com/example/repository/pull/99'
    },
    async () => {
      const queue = await prepareQueue(repository)
      assert.equal(queue.length, 1)
      const marker = queue[0]!.marker
      assert.equal(marker.releaseKey, releaseSha)
      assert.equal(marker.attempts, 0)
      assert.equal(marker.prUrl, undefined)
      assert.deepEqual(marker.flows, [])
      assert.equal(
        (marker.rootCause as { confidence: string }).confidence,
        'undetermined'
      )
      assert.equal(marker.priority, 'P2')
    }
  )
})

test('exhausted attempts become non-actionable and do not spin the scheduler', async () => {
  await fixture({ status: 'queued', attempts: 2 }, async (state) => {
    assert.deepEqual(await prepareQueue(repository), [])
    assert.equal(state.marker()?.status, 'reported')
    assert.equal(await hasUpdates(repository), false)
  })
})

test('an unchanged completed report does not schedule another repair', async () => {
  await fixture({ status: 'reported', attempts: 1 }, async (state) => {
    assert.equal(await hasUpdates(repository), false)
    assert.deepEqual(await prepareQueue(repository), [])
    assert.equal(state.writes.length, 0)
  })
})

test('a budget pause suppresses retries until its explicit reset boundary', async () => {
  await fixture(
    {
      status: 'budget-paused',
      attempts: 1,
      pausedUntil: new Date(Date.now() + 3_600_000).toISOString()
    },
    async (state) => {
      assert.equal(await hasUpdates(repository), false)
      assert.deepEqual(await prepareQueue(repository), [])
      assert.equal(state.writes.length, 0)
    }
  )
  await fixture(
    {
      status: 'budget-paused',
      attempts: 1,
      pausedUntil: new Date(Date.now() - 1_000).toISOString()
    },
    async () => {
      assert.equal(await hasUpdates(repository), true)
      assert.equal((await prepareQueue(repository)).length, 1)
    }
  )
})

test('budget-paused reports record the next UTC midnight and an authenticated update time', async () => {
  await fixture(undefined, async () => {
    const [job] = await prepareQueue(repository)
    assert.ok(job)
    const before = new Date()
    const result = await updateReport(repository, job, {
      status: 'budget-paused'
    })
    const paused = result.marker.pausedUntil!
    assert.equal(new Date(paused).getUTCHours(), 0)
    assert.equal(new Date(paused).getUTCMinutes(), 0)
    assert.ok(Date.parse(paused) > before.getTime())
    assert.ok(Date.parse(paused) <= before.getTime() + 86_400_000)
    assert.ok(Date.parse(result.marker.updatedAt!) >= before.getTime())
  })
})

test('updating an existing report preserves the published PR URL', async () => {
  await fixture(undefined, async () => {
    const [job] = await prepareQueue(repository)
    assert.ok(job)
    const prUrl = `https://github.com/${repository.owner}/${repository.repo}/pull/99`
    job.marker.prUrl = prUrl
    const updated = await updateReport(repository, job, { status: 'pr-open' })
    assert.equal(updated.marker.prUrl, prUrl)
    assert.equal(updated.body.includes(prUrl), true)
  })
})

test('a missing safe production event creates an honest report and never queues a repair', async () => {
  await fixture(undefined, async (state) => {
    state.latestFailure = true
    state.suppressRelease = true
    assert.deepEqual(await prepareQueue(repository), [])
    assert.equal(state.marker()?.status, 'reported')
    assert.match(
      state.marker()?.verification?.summary ?? '',
      /verified production event is required/
    )
    assert.match(state.body(), /HTTP 503/)
    assert.equal(await hasUpdates(repository), false)
    state.latestFailure = false
    assert.equal(await hasUpdates(repository), true)
    assert.equal((await prepareQueue(repository)).length, 1)
  })
})

test('fresh event counts preserve the same-release diagnosis and verification proof', async () => {
  await fixture(
    {
      status: 'pr-open',
      lastSeen: '2026-01-01T00:00:00.000Z',
      attempts: 1,
      rootCause: {
        confidence: 'confirmed',
        summary: 'Validated diagnosis',
        evidence: ['A causal regression reproduced the observed event'],
        unknowns: []
      },
      verification: {
        status: 'passed',
        summary: 'Verified before and after the fix',
        regression: { before: 1, after: 0 },
        commands: [{ command: 'bun test', exitCode: 0, output: 'pass' }]
      },
      prUrl: `https://github.com/${repository.owner}/${repository.repo}/pull/99`
    },
    async (state) => {
      assert.deepEqual(await prepareQueue(repository), [])
      assert.equal(state.marker()?.verification?.regression?.after, 0)
      assert.match(state.body(), /Verified before and after the fix/)
      assert.match(state.body(), /Validated diagnosis/)
    }
  )
})

test('report updates keep an omitted diagnosis and persist bounded sanitized verification', async () => {
  await fixture(undefined, async () => {
    const [job] = await prepareQueue(repository)
    assert.ok(job)
    job.marker.rootCause = {
      confidence: 'confirmed',
      summary: 'Existing diagnosis',
      evidence: ['Existing causal evidence'],
      unknowns: []
    }
    const updated = await updateReport(repository, job, {
      status: 'reported',
      verification: {
        status: 'blocked',
        summary: 'x'.repeat(3_000),
        commands: Array.from({ length: 20 }, () => ({
          command: 'bun test',
          exitCode: 1,
          output: 'password="private-password" ' + 'x'.repeat(1_000)
        }))
      }
    })
    assert.equal(
      (updated.marker.rootCause as { summary: string }).summary,
      'Existing diagnosis'
    )
    assert.equal(updated.marker.verification?.summary.length, 1_500)
    assert.equal(updated.marker.verification?.commands?.length, 6)
    assert.ok(
      updated.marker.verification!.commands!.every(
        (command) => command.output.length <= 400
      )
    )
    assert.equal(
      JSON.stringify(updated.marker.verification).includes('private-password'),
      false
    )
  })
})

test('unauthorized or incomplete Sentry intake never causes GitHub writes', async () => {
  for (const reason of ['auth', 'pagination']) {
    await fixture(undefined, async (state) => {
      state.sentryFailure = reason === 'auth'
      state.paginateForever = reason === 'pagination'
      await assert.rejects(
        prepareQueue(repository),
        /Sentry reconciliation incomplete/
      )
      assert.deepEqual(state.writes, [])
    })
  }
})
