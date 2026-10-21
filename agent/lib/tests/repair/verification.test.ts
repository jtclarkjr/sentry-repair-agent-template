import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Sandbox } from '@vercel/sandbox'
import { repositories } from '../../registry'
import type { Candidate } from '../../repair/candidate'
import { verify, type VerificationProgress } from '../../repair/verification'

const repository = repositories[0]!
const sourcePath = 'src/handler.ts'
const testPath = 'src/failure.test.ts'
const candidate: Candidate = {
  baseSha: 'a'.repeat(40),
  rootCause: {
    confidence: 'probable',
    summary: 'The handler returns false for the incident input.',
    evidence: ['Stack frame handler.ts:1'],
    unknowns: []
  },
  flows: [],
  patch: `diff --git a/${sourcePath} b/${sourcePath}
index 1234567..2345678 100644
--- a/${sourcePath}
+++ b/${sourcePath}
@@ -1 +1 @@
-export const value = false;
+export const value = true;
`,
  regressionPatch: `diff --git a/${testPath} b/${testPath}
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/${testPath}
@@ -0,0 +1 @@
+test('incident regression', () => {});
`,
  regressionPath: testPath,
  runner: 'bun',
  expectedFailure: 'incident regression',
  browserRequired: false,
  browserCovered: false,
  blocker: null
}

type Scenario = {
  baselineFailure?: boolean
  before?: { exitCode: number; output: string }
  mutateSource?: 'before' | 'after'
}

async function run(scenario: Scenario = {}) {
  const originalGet = Sandbox.get
  const state = {
    testAdded: false,
    fixApplied: false,
    fingerprint: 'a'.repeat(64),
    regressions: [] as ('before' | 'after')[]
  }
  const contents: Record<string, Buffer> = {
    [sourcePath]: Buffer.from('export const value = true;'),
    [testPath]: Buffer.from("test('incident regression', () => {});")
  }
  const reply = (output = '', exitCode = 0) => ({
    exitCode,
    stdout: async () => output,
    stderr: async () => ''
  })
  const sandbox = {
    runCommand: async ({ cmd, args }: { cmd: string; args: string[] }) => {
      if (cmd === 'bash') {
        const command = args[1]!
        if (command.includes('../regression.patch')) state.testAdded = true
        else if (command.includes('../repair.patch')) {
          state.fixApplied = true
          state.fingerprint = 'b'.repeat(64)
        } else if (command.includes('bun test ')) {
          assert.equal(state.testAdded, true)
          const phase = state.fixApplied ? 'after' : 'before'
          state.regressions.push(phase)
          if (scenario.mutateSource === phase)
            state.fingerprint = 'c'.repeat(64)
          const result = phase === 'before'
            ? scenario.before ?? { exitCode: 1, output: 'AssertionError: incident regression' }
            : { exitCode: 0, output: '1 pass' }
          return reply(result.output, result.exitCode)
        } else if (
          scenario.baselineFailure &&
          command.includes(repository.checkCommands[0]!)
        ) return reply('Unrelated existing test failed', 1)
        return reply()
      }
      if (cmd === '/usr/bin/git') {
        if (args[0] === 'diff')
          return reply(state.fixApplied ? `${sourcePath}\0` : '')
        assert.equal(args[0], 'ls-files')
        return reply(state.testAdded ? `${testPath}\0` : '')
      }
      if (cmd === '/usr/bin/stat')
        return reply(`${contents[args.at(-1)!]!.length}:81a4`)
      assert.equal(cmd, 'node')
      return reply(state.fingerprint)
    },
    readFileToBuffer: async ({ path }: { path: string }) =>
      contents[path.replace('/vercel/sandbox/repo/', '')]
  }
  Sandbox.get = (async () => sandbox) as unknown as typeof Sandbox.get
  const progress: VerificationProgress = { commands: [] }
  try {
    const result = await verify(
      repository.id,
      'synthetic-verification',
      candidate,
      Date.now() + 60_000,
      progress
    )
    return { result, progress, state }
  } finally {
    Sandbox.get = originalGet
  }
}

test('verification requires a failing baseline regression, a passing fix, and all configured checks', async () => {
  const { result, progress, state } = await run()
  assert.equal(result.status, 'passed')
  assert.deepEqual(state.regressions, ['before', 'after'])
  assert.deepEqual(result.regression, { before: 1, after: 0 })
  assert.deepEqual(progress.regression, result.regression)
  assert.deepEqual(result.files.map((file) => file.path), [sourcePath, testPath].sort())
  assert.equal(result.files.find((file) => file.path === sourcePath)!.content, 'export const value = true;')
  for (const check of repository.checkCommands)
    assert.equal(result.commands.filter(({ command }) => command === check).length, 2)
})

test('a failing clean baseline blocks before applying the regression or source fix', async () => {
  const { result, state } = await run({ baselineFailure: true })
  assert.equal(result.status, 'blocked')
  assert.match(result.summary, /Unmodified repository baseline failed/)
  assert.equal(state.testAdded, false)
  assert.equal(state.fixApplied, false)
  assert.deepEqual(result.files, [])
})

test('a passing regression, wrong failure, or non-assertion error cannot authorize a repair', async () => {
  for (const before of [
    { exitCode: 0, output: 'AssertionError: incident regression' },
    { exitCode: 1, output: 'AssertionError: unrelated failure' },
    { exitCode: 1, output: 'SyntaxError: incident regression' }
  ]) {
    const { result, state } = await run({ before })
    assert.equal(result.status, 'blocked')
    assert.match(result.summary, /did not fail with the expected incident assertion/)
    assert.equal(state.fixApplied, false)
    assert.deepEqual(state.regressions, ['before'])
    assert.deepEqual(result.files, [])
  }
})

test('source mutation during either regression blocks publication of the candidate', async () => {
  for (const mutateSource of ['before', 'after'] as const) {
    const { result, state } = await run({ mutateSource })
    assert.equal(result.status, 'blocked')
    assert.match(result.summary, mutateSource === 'before'
      ? /Baseline regression changed itself or repository source/
      : /changed the frozen candidate or tracked source/)
    assert.deepEqual(state.regressions, mutateSource === 'before'
      ? ['before']
      : ['before', 'after'])
    assert.deepEqual(result.files, [])
  }
})
