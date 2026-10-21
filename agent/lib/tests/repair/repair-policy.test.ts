import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blockedVerification, browserVerificationBlocker, candidateReportContext, isGatewayBudgetFailure, recordedAttempts, repairBlockers, unverifiedFlows, withOptionalVercelUncertainty, withTestEnvironment } from '../../repair/policy'
import { repositories, type RepositoryConfig } from '../../registry'
import type { IncidentEvidence } from '../../incidents/model'

const sha = 'a'.repeat(40)
const repo = (): RepositoryConfig => ({
  ...repositories[0]!,
  repairReadiness: {
    baseline: {
      status: 'verified',
      sha,
      evidence: 'Clean configured gates passed in an isolated archive.'
    },
    sourceMaps: {
      status: 'verified',
      evidence:
        'The uploaded production source map resolves the release to this GitHub repository.'
    }
  }
})
const incident: IncidentEvidence = {
  org: 'your-sentry-org',
  project: 'your-sentry-project',
  issueId: '123',
  title: 'AI request fails',
  url: 'https://sentry.io/organizations/your-sentry-org/issues/123/',
  firstSeen: '2026-10-21T00:00:00.000Z',
  lastSeen: '2026-10-21T01:00:00.000Z',
  environment: 'production',
  releaseSha: sha,
  volume: {
    '15m': { events: 1, affectedUsers: 1 },
    '1h': { events: 1, affectedUsers: 1 },
    '24h': { events: 1, affectedUsers: 1 },
    previous15m: { events: 0, affectedUsers: 0 }
  }
}
const deployment = { state: 'READY', sha }

test('the configured browser report-only gate cannot be bypassed by model coverage claims', () => {
  for (const config of repositories) {
    assert.equal(config.browserVerification, 'report-only')
    assert.match(
      browserVerificationBlocker(config, true, ['lib/parser.ts'])!,
      /report-only/
    )
    for (const path of [
      'components/chat.tsx',
      'src/lib/chat/room.svelte',
      'hooks/use-chat.ts',
      'src/routes/+page.ts'
    ])
      assert.match(
        browserVerificationBlocker(config, false, [path])!,
        /model browser-coverage claim cannot authorize/
      )
    assert.equal(
      browserVerificationBlocker(config, false, ['lib/parser.ts']),
      undefined
    )
  }
})

test('repair requires independently configured rollout gates and matching production commit evidence', () => {
  assert.deepEqual(repairBlockers(repo(), incident, sha, [deployment]), [])
  for (const gate of ['baseline', 'sourceMaps'] as const) {
    const config = repo()
    config.repairReadiness[gate] = {
      status: 'pending',
      evidence: `${gate} evidence is missing`
    }
    assert.match(
      repairBlockers(config, incident, sha, [deployment]).join(),
      /pending/
    )
  }
  const malformed = repo()
  malformed.repairReadiness.baseline.sha = 'short'
  assert.match(
    repairBlockers(malformed, incident, sha, [deployment]).join(),
    /Clean baseline/
  )
  assert.match(
    repairBlockers(repo(), { ...incident, environment: 'preview' }, sha, [
      deployment
    ]).join(),
    /production environment/
  )
  assert.match(
    repairBlockers(repo(), { ...incident, releaseSha: sha.slice(0, 7) }, sha, [
      deployment
    ]).join(),
    /full GitHub release SHA/
  )
})

test('optional missing Vercel metadata does not waive required Sentry readiness checks', () => {
  assert.deepEqual(repairBlockers(repo(), incident, sha, []), [])
  const pending = repo()
  pending.repairReadiness.sourceMaps.status = 'pending'
  assert.match(
    repairBlockers(pending, incident, sha, []).join(),
    /Source-map and release/
  )
  assert.match(
    repairBlockers(
      repo(),
      { ...incident, releaseSha: undefined },
      sha,
      []
    ).join(),
    /full GitHub release SHA/
  )
})

test('returned contradictory deployment metadata and an advanced default branch remain report-only', () => {
  assert.match(
    repairBlockers(repo(), incident, sha, [
      { ...deployment, state: 'ERROR' }
    ]).join(),
    /no READY deployment matching/
  )
  assert.match(
    repairBlockers(repo(), incident, sha, [
      { ...deployment, sha: 'b'.repeat(40) }
    ]).join(),
    /no READY deployment matching/
  )
  const drift = repairBlockers(repo(), incident, 'b'.repeat(40), [
    deployment
  ]).join()
  assert.match(drift, /default branch differs/)
  assert.match(drift, /does not establish that the incident is unfixable/)
})

test('optional Vercel uncertainty is recorded without changing independent verification proof', () => {
  const verification = {
    status: 'passed',
    summary: 'Causal regression and all gates passed.',
    commands: [
      { command: 'bun test regression.test.ts', exitCode: 0, output: 'Passed' }
    ],
    regression: { before: 1, after: 0 },
    files: [{ path: 'src/fix.ts', content: 'source' }]
  }
  for (const errors of [
    [
      'Vercel: VERCEL_READ_TOKEN missing; deployment metadata and runtime logs unavailable'
    ],
    ['Vercel: HTTP 403'],
    []
  ]) {
    const report = withOptionalVercelUncertainty(verification, {
      deployments: [],
      errors,
      historicalLogsComplete: false
    })
    assert.equal(report.status, 'passed')
    assert.deepEqual(report.commands, verification.commands)
    assert.deepEqual(report.regression, verification.regression)
    assert.deepEqual(report.files, verification.files)
    assert.match(report.summary, /Deployment metadata is unavailable/)
    assert.match(
      report.summary,
      /complete historical log coverage is unavailable/
    )
    if (errors.length) assert.ok(report.summary.includes(errors[0]!))
  }
  assert.deepEqual(
    withOptionalVercelUncertainty(verification, {
      deployments: [deployment],
      errors: [],
      historicalLogsComplete: true
    }),
    verification
  )
})

test('optional log failures remain explicit even with matching READY deployment metadata', () => {
  const report = withOptionalVercelUncertainty(
    { status: 'passed', summary: 'Verified causal fix.' },
    {
      deployments: [deployment],
      errors: ['Vercel: runtime logs HTTP 403 for user@example.com'],
      historicalLogsComplete: false
    }
  )
  assert.equal(report.status, 'passed')
  assert.doesNotMatch(
    report.summary,
    /Deployment metadata is unavailable|user@example.com/
  )
  assert.match(report.summary, /runtime logs HTTP 403/)
  assert.match(report.summary, /bounded live sample at most/)
})

test('invalid or absent patches still retain valid probable RCA and explicit flow uncertainty', () => {
  const context = candidateReportContext({
    patch: 'invalid patch',
    blocker: 'Infrastructure credentials unavailable',
    rootCause: {
      confidence: 'confirmed',
      summary: 'Response parser assumes a missing field exists.',
      evidence: ['Production stack points to parseResponse at api.ts:42.'],
      unknowns: ['Independent regression has not run.']
    },
    flows: [
      {
        flowId: 'ai',
        impact: 'blocked',
        confidence: 'verified',
        evidence: ['Model hypothesis only'],
        systemWide: true,
        dataLoss: true
      }
    ]
  })
  assert.ok(context)
  assert.equal(context.rootCause.confidence, 'probable')
  assert.match(context.rootCause.summary, /Response parser/)
  const [flow] = unverifiedFlows(context)
  assert.equal(flow?.impact, 'unknown')
  assert.equal(flow?.confidence, 'unknown')
  assert.equal(flow?.systemWide, false)
  assert.equal(flow?.dataLoss, false)
  assert.match(
    flow!.evidence.join(),
    /Independent causal verification is incomplete/
  )
  assert.equal(
    candidateReportContext({
      rootCause: {
        confidence: 'confirmed',
        summary: 'No evidence',
        evidence: [],
        unknowns: []
      }
    }),
    undefined
  )
})

test('undetermined RCA stays undetermined and malformed model flows cannot discard valid RCA', () => {
  const context = candidateReportContext({
    rootCause: {
      confidence: 'undetermined',
      summary: 'A database failure is possible.',
      evidence: [],
      unknowns: ['No transaction trace.']
    },
    flows: [{ flowId: 'ai', impact: 'blocked', evidence: [] }]
  })
  assert.equal(context?.rootCause.confidence, 'undetermined')
  assert.deepEqual(context?.flows, [])
})

test('blocked reporting preserves actual commands, regression exits and the original failure', () => {
  const commands = [
    {
      command: 'bun run check',
      exitCode: 1,
      output: 'Expected: successful AI response'
    }
  ]
  const report = blockedVerification('Sandbox cleanup failed', {
    status: 'blocked',
    summary: 'Required check failed',
    commands,
    regression: { before: 1, after: 0 }
  })
  assert.deepEqual(report.commands, commands)
  assert.deepEqual(report.regression, { before: 1, after: 0 })
  assert.match(report.summary, /Required check failed/)
  assert.match(report.summary, /cleanup failed/)
})

test('only recognizable budget failures pause without consuming an attempt', () => {
  assert.equal(
    isGatewayBudgetFailure({
      message: 'Generation failed',
      cause: { statusCode: 402, message: 'Unavailable' }
    }),
    true
  )
  assert.equal(
    isGatewayBudgetFailure({
      responseBody: JSON.stringify({ error: { code: 'insufficient_credits' } })
    }),
    true
  )
  assert.equal(
    isGatewayBudgetFailure(new Error('AI Gateway budget exhausted')),
    true
  )
  assert.equal(
    isGatewayBudgetFailure({ statusCode: 429, message: 'Rate limit exceeded' }),
    false
  )
  assert.equal(
    isGatewayBudgetFailure(
      new Error('Invalid error response format: Gateway request failed')
    ),
    false
  )
  assert.equal(
    isGatewayBudgetFailure(new Error('Customer quota lookup failed')),
    false
  )
  assert.equal(recordedAttempts(1, true), 0)
  assert.equal(recordedAttempts(2, true), 1)
  assert.equal(recordedAttempts(1, false), 1)
  assert.equal(recordedAttempts(2, false), 2)
})

test('trusted fixture environment is applied to the entire command and safely shell quoted', () => {
  const command = withTestEnvironment(
    {
      ...repo(),
      testEnvironment: {
        NEXT_PUBLIC_APP_NAME: "Chat's test",
        NEXT_PUBLIC_EXTERNAL_API_URL: 'https://api.storybook.invalid/api/v1'
      }
    },
    'bun run check && bun run build'
  )
  assert.equal(
    command,
    "export NEXT_PUBLIC_APP_NAME='Chat'\\''s test' NEXT_PUBLIC_EXTERNAL_API_URL='https://api.storybook.invalid/api/v1'; bun run check && bun run build"
  )
  assert.throws(() =>
    withTestEnvironment(
      { ...repo(), testEnvironment: { 'BAD;KEY': 'x' } },
      'bun test'
    )
  )
  assert.equal(
    withTestEnvironment({ ...repo(), testEnvironment: {} }, 'bun test'),
    'bun test'
  )
})
