import { type ChangedFile } from '../github/publish'
import { type CommandResult } from './sandbox'
import { type Candidate } from './candidate'
import { type QueuedIncident } from '../incidents/queue'
import { getRepository as repository } from '../registry'
import { sanitizeText } from '../redaction'
import {
  browserVerificationBlocker,
  repairBlockers,
  withTestEnvironment
} from './policy'

export type Verification = {
  status: 'passed' | 'blocked'
  summary: string
  commands: CommandResult[]
  regression?: { before: number; after: number }
  files: ChangedFile[]
}

export async function beginVerification(
  repoId: string,
  job: QueuedIncident,
  candidate: Candidate,
  deployments: { state: string | null; sha: string | null }[],
  deadline: number
) {
  'use step'
  const { validateCandidate, patchPaths } = await import('./candidate')
  const { startVerification } = await import('./sandbox')
  const blockers = repairBlockers(
    repository(repoId),
    job.incident,
    job.baseSha,
    deployments
  )
  if (blockers.length) throw new Error(blockers.join('\n'))
  if (candidate.baseSha !== job.baseSha)
    throw new Error('Candidate base differs from trusted source commit')
  if (candidate.rootCause.confidence === 'undetermined')
    throw new Error(
      'The candidate does not identify a causal code defect; publish an investigation report'
    )
  const paths = patchPaths(candidate)
  const browserBlocker = browserVerificationBlocker(
    repository(repoId),
    candidate.browserRequired,
    paths
  )
  if (browserBlocker) throw new Error(browserBlocker)
  const uiChange = paths.some((path) =>
    /\.(?:tsx|svelte)$|^(?:components|hooks)\//.test(path)
  )
  if (uiChange && !candidate.browserRequired)
    throw new Error('UI changes require a real browser-flow regression')
  validateCandidate(candidate)
  return startVerification(repository(repoId), candidate, deadline)
}
export type VerificationProgress = Pick<Verification, 'commands' | 'regression'>
export async function verify(
  repoId: string,
  name: string,
  candidate: Candidate,
  deadline: number,
  progress: VerificationProgress
): Promise<Verification> {
  const config = await verificationConfig(repoId)
  const commands = progress.commands
  let regression: Verification['regression']
  try {
    for (const command of config.setup) {
      const result = await runCheck(name, command, deadline)
      commands.push(result)
      if (result.exitCode !== 0)
        return {
          status: 'blocked',
          summary: 'Repository setup failed; the incident was not reproduced',
          commands,
          files: []
        }
    }
    for (const command of config.checks) {
      const result = await runCheck(name, command, deadline)
      commands.push(result)
      if (result.exitCode !== 0)
        return {
          status: 'blocked',
          summary:
            'Unmodified repository baseline failed; unrelated failures cannot be waived',
          commands,
          files: []
        }
    }
    const addTest = await runCheck(
      name,
      'git apply --check ../regression.patch && git apply ../regression.patch',
      deadline
    )
    commands.push(addTest)
    if (addTest.exitCode !== 0)
      return {
        status: 'blocked',
        summary: 'Regression patch did not apply cleanly',
        commands,
        files: []
      }
    const baselineSnapshot = await snapshot(name, [candidate.regressionPath])
    const before = await runRegression(repoId, name, candidate, deadline)
    commands.push(before)
    if (
      baselineSnapshot.hash !==
      (await snapshot(name, [candidate.regressionPath])).hash
    )
      return {
        status: 'blocked',
        summary: 'Baseline regression changed itself or repository source',
        commands,
        files: []
      }
    if (
      before.exitCode === 0 ||
      !before.output.includes(candidate.expectedFailure) ||
      !/(?:AssertionError|Expected:|expect\(|toBe|toEqual|assert)/i.test(
        before.output
      )
    )
      return {
        status: 'blocked',
        summary:
          'Base revision did not fail with the expected incident assertion',
        commands,
        files: []
      }
    const apply = await runCheck(
      name,
      'git apply --check ../repair.patch && git apply ../repair.patch',
      deadline
    )
    commands.push(apply)
    if (apply.exitCode !== 0)
      return {
        status: 'blocked',
        summary: 'Source fix did not apply independently of the new regression',
        commands,
        files: []
      }
    const frozenCandidate = await candidateSnapshot(name, candidate)
    const after = await runRegression(repoId, name, candidate, deadline)
    commands.push(after)
    regression = { before: before.exitCode, after: after.exitCode }
    progress.regression = regression
    if (after.exitCode !== 0)
      return {
        status: 'blocked',
        summary: 'Regression still fails after the fix',
        commands,
        regression: { before: before.exitCode, after: after.exitCode },
        files: []
      }
    for (const command of config.checks) {
      const result = await runCheck(name, command, deadline)
      commands.push(result)
      if (result.exitCode !== 0)
        return {
          status: 'blocked',
          summary: 'A required repository check failed',
          commands,
          regression: { before: before.exitCode, after: after.exitCode },
          files: []
        }
    }
    const files = await verifiedFiles(name, candidate, frozenCandidate.hash)
    return {
      status: 'passed',
      summary:
        'Clean verification reproduced the expected failure before the fix, passed afterward, and passed every configured gate.',
      commands,
      regression: { before: before.exitCode, after: after.exitCode },
      files
    }
  } catch (error) {
    return {
      status: 'blocked',
      summary: sanitizeText(
        error instanceof Error ? error.message : 'Verification interrupted'
      ),
      commands,
      ...(regression ? { regression } : {}),
      files: []
    }
  }
}
async function verificationConfig(repoId: string) {
  'use step'
  const repo = repository(repoId)
  return {
    setup: [
      'command -v bun >/dev/null || npm install --prefix /tmp/runtime bun@1.3.14',
      ...repo.setupCommands.map((command) => withTestEnvironment(repo, command))
    ],
    checks: repo.checkCommands.map((command) =>
      withTestEnvironment(repo, command)
    )
  }
}
async function runCheck(name: string, command: string, deadline: number) {
  'use step'
  const { runVerificationCommand } = await import('./sandbox')
  return runVerificationCommand(name, command, deadline)
}
async function runRegression(
  repoId: string,
  name: string,
  candidate: Candidate,
  deadline: number
) {
  'use step'
  const { runVerificationCommand } = await import('./sandbox')
  const { regressionCommand } = await import('./candidate')
  return runVerificationCommand(
    name,
    withTestEnvironment(repository(repoId), regressionCommand(candidate)),
    deadline
  )
}
async function snapshot(name: string, paths: string[]) {
  'use step'
  const { snapshotCandidate } = await import('./snapshot')
  return snapshotCandidate(name, paths)
}
async function candidateSnapshot(name: string, candidate: Candidate) {
  'use step'
  const { snapshotCandidate } = await import('./snapshot')
  const { patchPaths } = await import('./candidate')
  return snapshotCandidate(name, patchPaths(candidate))
}
async function verifiedFiles(name: string, candidate: Candidate, hash: string) {
  'use step'
  const { collectVerifiedFiles } = await import('./snapshot')
  const { patchPaths } = await import('./candidate')
  return collectVerifiedFiles(name, patchPaths(candidate), hash)
}
export async function cleanup(name: string) {
  'use step'
  const { stopVerification } = await import('./sandbox')
  await stopVerification(name)
}
