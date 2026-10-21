import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { candidateSchema, patchPaths, quote, safePath, validateCandidate, type Candidate } from '../../repair/candidate'

const testPath = 'src/failure.test.ts'
const regressionPatch = `diff --git a/${testPath} b/${testPath}
new file mode 100644
index 0000000..1234567
--- /dev/null
+++ b/${testPath}
@@ -0,0 +1 @@
+test('incident regression', () => {});
`
const repairPatch = `diff --git a/src/handler.ts b/src/handler.ts
index 1234567..2345678 100644
--- a/src/handler.ts
+++ b/src/handler.ts
@@ -1 +1 @@
-export const value = false;
+export const value = true;
`
function candidate(overrides: Partial<Candidate> = {}): Candidate {
  return candidateSchema.parse({
    baseSha: 'a'.repeat(40),
    rootCause: {
      confidence: 'probable',
      summary: 'The handler returns false for the incident input.',
      evidence: ['Stack frame handler.ts:1'],
      unknowns: []
    },
    flows: [],
    patch: repairPatch,
    regressionPatch,
    regressionPath: testPath,
    runner: 'bun',
    expectedFailure: 'incident regression',
    browserRequired: false,
    browserCovered: false,
    blocker: null,
    ...overrides
  })
}
function deletion(path: string): string {
  return `diff --git a/${path} b/${path}
deleted file mode 100644
index 1234567..0000000
--- a/${path}
+++ /dev/null
@@ -1 +0,0 @@
-original content
`
}
function addition(path: string, mode: string): string {
  return `diff --git a/${path} b/${path}
new file mode ${mode}
index 0000000..1234567
--- /dev/null
+++ b/${path}
@@ -0,0 +1 @@
+added content
`
}

test('candidate accepts an ordinary text repair and separate new regression', () => {
  assert.doesNotThrow(() => validateCandidate(candidate()))
  assert.equal(safePath('src/routes/(app)/[roomId]/+page.svelte'), true)
  assert.equal(safePath('components/chat/handler.tsx'), true)
})

test('protected paths, traversal, and shell-special paths cannot be published', () => {
  for (const path of [
    '../secret',
    '/etc/passwd',
    'src/../config.ts',
    '.git/config',
    '.github/workflows/ci.yml',
    '.env.production',
    'src/package.json',
    'bun.lock',
    'scripts/verify.ts',
    'vitest.config.ts',
    'src/file;echo-secret.ts'
  ]) {
    assert.equal(safePath(path), false, path)
  }
  assert.equal(quote("a'b"), "'a'\\''b'")
})

test('new executable, symlink, and submodule modes require manual review', () => {
  for (const mode of ['100755', '120000', '160000']) {
    assert.throws(
      () =>
        validateCandidate(
          candidate({ patch: addition('src/new-file.ts', mode) })
        ),
      Error,
      mode
    )
  }
})

test('regression patch must not delete source in addition to adding its test', () => {
  assert.throws(() =>
    validateCandidate(
      candidate({
        regressionPatch: regressionPatch + deletion('src/handler.ts')
      })
    )
  )
})

test('repair patch cannot delete preexisting tests', () => {
  assert.throws(() =>
    validateCandidate(
      candidate({ patch: repairPatch + deletion('src/previous.test.ts') })
    )
  )
})

test('a model browser claim cannot replace the required browser runner', () => {
  assert.throws(() =>
    validateCandidate(
      candidate({ browserRequired: true, browserCovered: true, runner: 'bun' })
    )
  )
  assert.throws(() =>
    validateCandidate(
      candidate({
        browserRequired: true,
        browserCovered: false,
        runner: 'playwright'
      })
    )
  )
})

test('diff header paths cannot hide a protected file or rename', () => {
  assert.throws(() =>
    validateCandidate(
      candidate({
        patch: repairPatch.replace(
          'diff --git a/src/handler.ts b/src/handler.ts',
          'diff --git a/.env b/.env'
        )
      })
    )
  )
  assert.throws(() =>
    validateCandidate(
      candidate({
        patch: repairPatch.replace('+++ b/src/handler.ts', '+++ b/src/other.ts')
      })
    )
  )
  assert.deepEqual(patchPaths(candidate()), ['src/handler.ts', testPath])
})
