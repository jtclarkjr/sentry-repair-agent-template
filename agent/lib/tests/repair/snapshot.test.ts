import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Sandbox } from '@vercel/sandbox'
import { collectVerifiedFiles, snapshotCandidate } from '../../repair/snapshot'

const testPath = 'src/failure.test.ts'

async function withSandbox(
  run: (state: {
    tracked: string[]
    untracked: string[]
    fingerprint: string
    contents: Record<string, Buffer | undefined>
    mode: string
    commands: { cmd: string; args: string[] }[]
  }) => Promise<void>
) {
  const originalGet = Sandbox.get
  const state = {
    tracked: ['src/handler.ts', 'reports/generated.md'],
    untracked: [testPath],
    fingerprint: 'a'.repeat(64),
    contents: {
      'src/handler.ts': Buffer.from('fixed source'),
      [testPath]: Buffer.from('regression test')
    } as Record<string, Buffer | undefined>,
    mode: '81a4',
    commands: [] as { cmd: string; args: string[] }[]
  }
  const success = (output = '') => ({
    exitCode: 0,
    stdout: async () => output,
    stderr: async () => ''
  })
  const sandbox = {
    runCommand: async (request: { cmd: string; args: string[] }) => {
      state.commands.push(request)
      if (request.cmd === '/usr/bin/git') {
        if (request.args[0] === 'diff') {
          assert.deepEqual(request.args, ['diff', 'HEAD', '--name-only', '-z'])
          return success(state.tracked.join('\0') + '\0')
        }
        assert.deepEqual(request.args, [
          'ls-files',
          '--others',
          '--exclude-standard',
          '-z'
        ])
        return success(state.untracked.join('\0') + '\0')
      }
      if (request.cmd === '/usr/bin/stat') {
        const path = request.args.at(-1)!
        if (!state.contents[path]) return { ...success(), exitCode: 1 }
        return success(`${state.contents[path]!.length}:${state.mode}`)
      }
      assert.equal(request.cmd, 'node')
      assert.ok(request.args[1]!.includes("['rev-parse', 'HEAD']"))
      assert.ok(request.args[1]!.includes("['ls-files', '-z']"))
      assert.ok(request.args[1]!.includes('lstatSync'))
      return success(state.fingerprint)
    },
    readFileToBuffer: async ({ path }: { path: string }) => {
      return state.contents[path.replace('/vercel/sandbox/repo/', '')]
    }
  }
  Sandbox.get = (async () => sandbox) as unknown as typeof Sandbox.get
  try {
    await run(state)
  } finally {
    Sandbox.get = originalGet
  }
}

test('publication inspects the complete tracked diff and permits generated reports only', async () => {
  await withSandbox(async (state) => {
    const expected = ['src/handler.ts', testPath]
    const snapshot = await snapshotCandidate('mock', expected)
    assert.deepEqual(
      snapshot.files.map((file) => file.path),
      [...expected].sort()
    )
    assert.equal(snapshot.hash.length, 64)
    assert.deepEqual(
      await collectVerifiedFiles('mock', expected, snapshot.hash),
      snapshot.files
    )
    assert.equal(
      state.commands.some((command) => command.args[0] === 'add'),
      false
    )
    state.tracked.push('src/unexpected.ts')
    await assert.rejects(
      collectVerifiedFiles('mock', expected, snapshot.hash),
      /differs from the approved paths/
    )
  })
})

test('unexpected untracked source and missing expected paths block publication', async () => {
  await withSandbox(async (state) => {
    state.untracked.push('src/sneaky.ts')
    await assert.rejects(
      snapshotCandidate('mock', ['src/handler.ts', testPath]),
      /differs from the approved paths/
    )
    state.untracked = []
    await assert.rejects(
      snapshotCandidate('mock', ['src/handler.ts', testPath]),
      /differs from the approved paths/
    )
  })
})

test('deleted candidate paths do not require intent-to-add and publish as null', async () => {
  await withSandbox(async (state) => {
    state.contents['src/handler.ts'] = undefined
    const snapshot = await snapshotCandidate('mock', [
      'src/handler.ts',
      testPath
    ])
    assert.equal(
      snapshot.files.find((file) => file.path === 'src/handler.ts')?.content,
      null
    )
    assert.equal(
      state.commands.some(
        (command) => command.cmd === 'bash' || command.args[0] === 'add'
      ),
      false
    )
  })
})

test('tests cannot self-modify the frozen repair, regression, or unrelated tracked source', async () => {
  await withSandbox(async (state) => {
    const expected = ['src/handler.ts', testPath]
    const snapshot = await snapshotCandidate('mock', expected)
    state.contents['src/handler.ts'] = Buffer.from('test replaced the fix')
    await assert.rejects(
      collectVerifiedFiles('mock', expected, snapshot.hash),
      /changed the frozen candidate/
    )
    state.contents['src/handler.ts'] = Buffer.from('fixed source')
    state.contents[testPath] = Buffer.from('test.skip();')
    await assert.rejects(
      collectVerifiedFiles('mock', expected, snapshot.hash),
      /changed the frozen candidate/
    )
    state.contents[testPath] = Buffer.from('regression test')
    state.fingerprint = 'b'.repeat(64)
    await assert.rejects(
      collectVerifiedFiles('mock', expected, snapshot.hash),
      /changed the frozen candidate/
    )
  })
})

test('symlink, executable and non-UTF-8 candidate files fail closed', async () => {
  await withSandbox(async (state) => {
    for (const mode of ['a1ff', '81ed']) {
      state.mode = mode
      await assert.rejects(
        snapshotCandidate('mock', ['src/handler.ts', testPath]),
        /regular non-executable/
      )
    }
    state.mode = '81a4'
    state.contents[testPath] = Buffer.from([0xff])
    await assert.rejects(
      snapshotCandidate('mock', ['src/handler.ts', testPath]),
      /UTF-8/
    )
  })
})
