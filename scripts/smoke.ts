import assert from 'node:assert/strict'
import { pathToFileURL } from 'node:url'
import { generateText, gateway } from 'ai'
import { Sandbox } from '@vercel/sandbox'
import { sandboxCommand } from '../agent/lib/repair/sandbox'
import { sanitizeText } from '../agent/lib/redaction'

const model = 'openai/gpt-6.1-sol'

export function requireMonitorOidc(
  env: NodeJS.ProcessEnv = process.env,
  now = Date.now()
) {
  assert(
    env.VERCEL_PROJECT_ID?.trim(),
    'Set VERCEL_PROJECT_ID to the monitor project ID.'
  )
  assert(
    env.VERCEL_TEAM_ID?.trim(),
    'Set VERCEL_TEAM_ID to the monitor team ID.'
  )
  assert(
    env.VERCEL_OIDC_TOKEN,
    'Pull the configured monitor project’s development OIDC token before the live smoke.'
  )
  assert(
    !env.AI_GATEWAY_API_KEY && !env.VERCEL_TOKEN,
    'The smoke requires project OIDC without an API-key or access-token fallback.'
  )
  let claims: { project_id?: string; owner_id?: string; exp?: number }
  try {
    claims = JSON.parse(
      Buffer.from(env.VERCEL_OIDC_TOKEN.split('.')[1], 'base64url').toString()
    )
    assert(claims && typeof claims === 'object')
  } catch {
    throw new Error(
      'Invalid OIDC token claims; pull a fresh token for the configured project.'
    )
  }
  assert.equal(
    claims.project_id,
    env.VERCEL_PROJECT_ID,
    'OIDC must belong to VERCEL_PROJECT_ID.'
  )
  assert.equal(
    claims.owner_id,
    env.VERCEL_TEAM_ID,
    'OIDC must belong to VERCEL_TEAM_ID.'
  )
  assert(
    typeof claims.exp === 'number' &&
      Number.isFinite(claims.exp) &&
      claims.exp > now / 1000,
    'Development OIDC expired or has no valid expiry; pull a fresh token for the same project.'
  )
}

export async function modelSmoke() {
  requireMonitorOidc()
  const result = await generateText({
    model,
    prompt: 'Output OK',
    maxOutputTokens: 20,
    reasoning: 'minimal',
    maxRetries: 0,
    abortSignal: AbortSignal.timeout(60_000)
  })
  assert.equal(
    result.text.trim(),
    'OK',
    'Model did not return the expected smoke response.'
  )
  const id = result.finalStep.providerMetadata?.gateway?.generationId
  assert.equal(
    typeof id,
    'string',
    'Gateway generation metadata is required to confirm routing.'
  )
  console.log(
    JSON.stringify({
      check: 'gateway-response',
      status: 'passed',
      generationId: id,
      responseModel: result.finalStep.response.modelId,
      output: result.text.trim(),
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens
    })
  )
  const info = await lookupGeneration(id as string)
  assert.equal(info.model, model, 'Gateway reported a different model.')
  assert.equal(
    info.isByok,
    false,
    'Smoke must use metered Gateway credits under the project cap.'
  )
  assert(
    Number.isFinite(info.totalCost) && info.totalCost >= 0,
    'Gateway must return a measured cost.'
  )
  console.log(
    JSON.stringify({
      check: 'gateway',
      status: 'passed',
      model: info.model,
      responseModel: result.finalStep.response.modelId,
      provider: info.providerName,
      generationId: info.id,
      output: result.text.trim(),
      inputTokens: result.usage.inputTokens,
      outputTokens: result.usage.outputTokens,
      costUsd: info.totalCost
    })
  )
}

export async function lookupGeneration(id: string) {
  for (const delay of [0, 10_000, 30_000, 60_000]) {
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
    try {
      return await gateway.getGenerationInfo({ id })
    } catch (error) {
      if (
        delay === 60_000 ||
        !(
          error &&
          typeof error === 'object' &&
          'statusCode' in error &&
          error.statusCode === 404
        )
      )
        throw error
    }
  }
  throw new Error('Gateway usage ingestion did not complete.')
}

export function smokeFailure(error: unknown) {
  const detail =
    error && typeof error === 'object'
      ? (error as {
          name?: string
          statusCode?: number
          message?: string
          cause?: { name?: string; statusCode?: number; message?: string }
        })
      : {}
  return {
    name: detail.name,
    statusCode: detail.statusCode,
    message: sanitizeText(detail.message ?? 'Unknown failure'),
    causeName: detail.cause?.name,
    causeStatusCode: detail.cause?.statusCode,
    causeMessage: detail.cause?.message
      ? sanitizeText(detail.cause.message)
      : undefined
  }
}

const syntheticFixtures = [
  {
    name: 'synthetic-chat-delivery-boundary',
    broken: 'export const deliver = text => text.slice(0, -1);',
    fixed: 'export const deliver = text => text;',
    test: "import assert from 'node:assert/strict'; import {deliver} from './logic.mjs'; assert.equal(deliver('a'), 'a', 'chat-delivery-boundary');",
    expected: 'chat-delivery-boundary'
  },
  {
    name: 'synthetic-canvas-persistence',
    broken: 'export const save = canvas => ({title: canvas.title});',
    fixed: 'export const save = canvas => structuredClone(canvas);',
    test: "import assert from 'node:assert/strict'; import {save} from './logic.mjs'; const canvas={title:'draft',shapes:[{id:'shape-1',x:1}]}; assert.deepEqual(save(canvas), canvas, 'canvas-persistence');",
    expected: 'canvas-persistence'
  }
]

async function sandboxSmoke() {
  const sandbox = await Sandbox.create({
    name: `sentry-repair-smoke-${Date.now()}`,
    image: 'vercel/sandbox/node:24',
    region: 'hnd1',
    persistent: false,
    timeout: 300_000,
    resources: { vcpus: 2 },
    networkPolicy: {
      allow: {
        'registry.npmjs.org': [],
        'registry.npmjs.com': [],
        'github.com': [],
        'codeload.github.com': [],
        '*.githubusercontent.com': []
      }
    },
    signal: AbortSignal.timeout(90_000)
  })
  console.log(
    JSON.stringify({
      check: 'sandbox-create',
      status: 'passed',
      sdk: '3.8.0',
      name: sandbox.name,
      projectId: process.env.VERCEL_PROJECT_ID,
      synthetic: true
    })
  )
  const deadline = Date.now() + 240_000
  try {
    const pwd = await sandbox.runCommand({ cmd: 'pwd' })
    assert.equal(pwd.exitCode, 0)
    const cwd = (await pwd.stdout()).trim()
    const node = await sandboxCommand(
      sandbox,
      'node -p process.versions.node',
      cwd,
      deadline
    )
    assert.equal(node.exitCode, 0)
    assert.match(node.output.trim(), /^24\./, 'Sandbox must use Node 24.')
    const bun = await sandboxCommand(
      sandbox,
      'if test "$(bun --version 2>/dev/null)" != "1.3.14"; then npm install --prefix /tmp/runtime bun@1.3.14 --no-audit --no-fund >/dev/null; fi; bun --version',
      cwd,
      deadline
    )
    assert.equal(bun.exitCode, 0, 'Pinned Bun installation failed.')
    assert.match(bun.output.trim(), /^1\.3\.14/, 'Sandbox must use Bun 1.3.14.')
    console.log(
      JSON.stringify({
        check: 'sandbox-runtimes',
        status: 'passed',
        node: node.output.trim(),
        bun: bun.output.trim().split('\n')[0]
      })
    )
    for (const fixture of syntheticFixtures) {
      const directory = `${cwd}/${fixture.name}`
      await sandbox.mkDir(directory)
      await sandbox.writeFiles([
        { path: `${directory}/logic.mjs`, content: fixture.broken },
        { path: `${directory}/regression.mjs`, content: fixture.test }
      ])
      const before = await sandboxCommand(
        sandbox,
        'node regression.mjs',
        directory,
        deadline
      )
      assert.notEqual(
        before.exitCode,
        0,
        `${fixture.name}: base fixture unexpectedly passed.`
      )
      assert(
        before.output.includes('AssertionError') &&
          before.output.includes(fixture.expected),
        'Failure must be the expected incident assertion.'
      )
      await sandbox.writeFiles([
        { path: `${directory}/logic.mjs`, content: fixture.fixed }
      ])
      const after = await sandboxCommand(
        sandbox,
        'node regression.mjs',
        directory,
        deadline
      )
      assert.equal(
        after.exitCode,
        0,
        `${fixture.name}: fixed fixture still failed.`
      )
      console.log(
        JSON.stringify({
          check: fixture.name,
          status: 'passed',
          synthetic: true,
          before: before.exitCode,
          after: after.exitCode
        })
      )
    }
  } finally {
    const stopped = await sandbox.stop({ signal: AbortSignal.timeout(30_000) })
    console.log(
      JSON.stringify({
        check: 'sandbox-cleanup',
        status: stopped.status,
        name: sandbox.name,
        persistent: sandbox.persistent
      })
    )
  }
}

export async function liveSmoke() {
  requireMonitorOidc()
  const outcomes = await Promise.allSettled([modelSmoke(), sandboxSmoke()])
  const failures = outcomes.filter(
    (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected'
  )
  for (const failure of failures)
    console.error(
      JSON.stringify({
        check: 'live-smoke',
        status: 'failed',
        error: smokeFailure(failure.reason)
      })
    )
  console.log(
    'Synthetic infrastructure fixtures only. No monitored repository, production incident, baseline, browser flow, GitHub issue, or PR was verified or changed.'
  )
  return failures.length === 0
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  assert.deepEqual(
    process.argv.slice(2),
    ['--live'],
    'Usage: bun run scripts/smoke.ts --live (incurs Gateway and Sandbox usage charges).'
  )
  try {
    process.exitCode = (await liveSmoke()) ? 0 : 1
  } catch (error) {
    console.error(
      JSON.stringify({
        check: 'live-smoke',
        status: 'failed',
        error: smokeFailure(error)
      })
    )
    process.exitCode = 1
  }
}
