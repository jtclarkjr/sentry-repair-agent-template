import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Isolate module stubs from the adapter suites that exercise real implementations.
function run(scenario: string) {
  const modules = fileURLToPath(new URL('../../repair/', import.meta.url))
  const script = `
    import { mock } from 'bun:test';
    const scenario = ${JSON.stringify(scenario)};
    const modules = ${JSON.stringify(modules)};
    const calls = { records: [], failures: [], outcomes: 0, outcomeDetails: [], verify: 0, cleanup: 0, publish: 0, release: 0, sends: [] };
    const job = { incident: { issueId: '123' }, marker: { attempts: 0 }, report: { number: 7 } };
    const work = { repoId: 'example-app', job, evidence: { details: { vercel: { deployments: [], errors: [], historicalLogsComplete: false } } }, deadline: 100000, blockers: scenario === 'report-only' ? ['Baseline pending'] : [] };
    const data = {
      baseSha: 'a'.repeat(40), patch: 'fix', regressionPatch: 'test',
      regressionPath: 'src/regression.test.ts', expectedFailure: 'AssertionError',
      runner: 'bun', blocker: '', browserRequired: false, browserCovered: false, flows: [],
      rootCause: { confidence: 'probable', summary: 'Parser defect', evidence: ['Observed stack'], unknowns: [] }
    };
    const verification = { status: 'passed', summary: 'Verified', commands: [], regression: { before: 1, after: 0 }, files: [{ path: 'src/parser.ts', content: 'fixed' }] };
    mock.module(modules + 'state.ts', () => ({
      claimScope: async () => scenario === 'disabled' ? null : 'example-app',
      releaseScope: async () => { calls.release++; },
      loadWork: async () => scenario === 'idle' ? null : work,
      record: async (_repo, current, attempts) => { calls.records.push(attempts); return { marker: { ...current.marker, attempts }, report: current.report }; },
      recordFailure: async (_repo, _job, message, attempts, budget, context, verification) => { calls.failures.push({ message, attempts, budget, context, verification }); },
      recordOutcome: async (_repo, current, _candidate, outcome) => { calls.outcomes++; calls.outcomeDetails.push(outcome); return { marker: current.marker, report: current.report }; }
    }));
    let waits = 0;
    mock.module(modules + 'wait.ts', () => ({
      remainingTime: async () => scenario === 'expired' ? 0 : 100000,
      stageDeadline: async (deadline) => deadline,
      waitForActiveWork: async (pending, _repo, current) => {
        waits++;
        if (scenario === 'investigation-timeout' && waits === 1) return { kind: 'timeout', job: current };
        if (scenario === 'verification-timeout' && waits === 2) return { kind: 'timeout', job: current };
        if (['release-change', 'release-change-cleanup-failure'].includes(scenario) && waits === 2) return { kind: 'stopped', job: current, reason: 'Production release changed' };
        return { kind: 'complete', job: current, value: await pending };
      }
    }));
    mock.module(modules + 'verification.ts', () => ({
      beginVerification: async () => ({ name: 'synthetic-sandbox', commands: [] }),
      verify: async (_repo, _name, _candidate, _deadline, progress) => {
        calls.verify++;
        progress.commands.push({ command: 'bun test', exitCode: 0, output: 'passed' });
        const failed = scenario === 'verification-failed' || (scenario === 'retry' && calls.verify === 1);
        return { ...verification, status: failed ? 'blocked' : 'passed', summary: failed ? 'Required check failed' : 'Verified' };
      },
      cleanup: async () => { calls.cleanup++; if (scenario === 'release-change-cleanup-failure') throw new Error('Cleanup failed'); }
    }));
    mock.module(modules + 'publication.ts', () => ({
      publish: async (_repo, current) => {
        calls.publish++;
        return scenario === 'publication-failed' ? { status: 'publication-failed', job: current, reason: 'GitHub unavailable' } : { status: 'pr-open', url: 'https://github.com/example/app/pull/1' };
      }
    }));
    const ctx = {
      session: { auth: { current: {} } }, callId: 'synthetic-owner',
      agent: () => ({ send: async (message) => {
        calls.sends.push(JSON.parse(message));
        return { result: async () => scenario === 'budget' ? { status: 'failed', error: { message: 'AI Gateway budget exhausted' } } : { status: 'completed', data } };
      } })
    };
    const { runRepair } = await import(modules + 'workflow.ts');
    const result = await runRepair({}, ctx);
    console.log(JSON.stringify({ result, calls }));
  `
  const child = spawnSync(process.execPath, ['--eval', script], {
    encoding: 'utf8', env: { PATH: process.env.PATH }, timeout: 10_000
  })
  assert.equal(child.status, 0, child.stderr)
  return JSON.parse(child.stdout) as { result: { status: string; reason?: string }; calls: any }
}

test('disabled or idle coordination performs no investigation or publication', () => {
  for (const scenario of ['disabled', 'idle']) {
    const { result, calls } = run(scenario)
    assert.equal(result.status, scenario === 'disabled' ? 'disabled-or-busy' : 'idle')
    assert.equal(calls.sends.length, 0)
    assert.equal(calls.publish, 0)
    assert.equal(calls.release, scenario === 'disabled' ? 0 : 1)
  }
})

test('pending rollout gates save an investigation and never start verification', () => {
  const { result, calls } = run('report-only')
  assert.equal(result.status, 'reported')
  assert.match(calls.failures[0].message, /Baseline pending/)
  assert.equal(calls.failures[0].context.rootCause.confidence, 'probable')
  assert.equal(calls.verify, 0)
  assert.equal(calls.release, 1)
})

test('failed verification retries once with actual feedback and cleans both sandboxes', () => {
  const { result, calls } = run('retry')
  assert.equal(result.status, 'pr-open')
  assert.deepEqual(calls.records, [1, 2])
  assert.match(calls.sends[1].previousVerification, /Required check failed/)
  assert.equal(calls.outcomes, 1)
  assert.equal(calls.verify, 2)
  assert.equal(calls.cleanup, 2)
  assert.equal(calls.publish, 1)
  assert.equal(calls.release, 1)
})

test('two failed verifications stop without publication', () => {
  const { result, calls } = run('verification-failed')
  assert.equal(result.status, 'reported')
  assert.equal(calls.outcomes, 2)
  assert.equal(calls.cleanup, 2)
  assert.equal(calls.publish, 0)
})

test('Gateway budget failure pauses without starting a verification sandbox', () => {
  const { result, calls } = run('budget')
  assert.equal(result.status, 'budget-paused')
  assert.equal(calls.failures[0].budget, true)
  assert.equal(calls.verify, 0)
  assert.equal(calls.release, 1)
})

test('investigation timeout and an expired deadline save a blocked outcome', () => {
  for (const scenario of ['investigation-timeout', 'expired']) {
    const { result, calls } = run(scenario)
    assert.equal(result.status, 'reported')
    assert.match(calls.failures[0].message, /30 minutes|deadline reached/)
    assert.equal(calls.verify, 0)
    assert.equal(calls.publish, 0)
    assert.equal(calls.release, 1)
  }
})

test('verification timeout records completed commands and cleans the sandbox', () => {
  const { result, calls } = run('verification-timeout')
  assert.equal(result.status, 'pr-open')
  assert.equal(calls.outcomes, 1)
  assert.match(calls.outcomeDetails[0].summary, /Persisted incident execution deadline/)
  assert.equal(calls.outcomeDetails[0].commands[0].command, 'bun test')
  assert.equal(calls.cleanup, 2)
})

test('a release change cleans up without overwriting the refreshed report, even when cleanup fails', () => {
  for (const scenario of ['release-change', 'release-change-cleanup-failure']) {
    const { result, calls } = run(scenario)
    assert.equal(result.status, 'reported')
    assert.match(result.reason!, /Production release changed/)
    if (scenario.endsWith('failure')) assert.match(result.reason!, /Cleanup failed/)
    assert.equal(calls.cleanup, 1)
    assert.equal(calls.publish, 0)
    assert.equal(calls.failures.length, 0)
    assert.equal(calls.release, 1)
  }
})

test('publication failure retains verified evidence in the report', () => {
  const { result, calls } = run('publication-failed')
  assert.equal(result.status, 'reported')
  assert.equal(calls.failures[0].verification.status, 'passed')
  assert.equal(calls.cleanup, 1)
  assert.equal(calls.release, 1)
})

test('a verified candidate publishes once and always releases repository ownership', () => {
  const { result, calls } = run('success')
  assert.equal(result.status, 'pr-open')
  assert.equal(calls.verify, 1)
  assert.equal(calls.publish, 1)
  assert.equal(calls.cleanup, 1)
  assert.equal(calls.release, 1)
})
