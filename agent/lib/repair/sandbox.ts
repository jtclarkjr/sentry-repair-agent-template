import { Sandbox } from '@vercel/sandbox'
import { createGitHubClient } from '../github/client'
import { sanitizeText } from '../redaction'
import { quote, validateCandidate, type Candidate } from './candidate'
import { type RepositoryConfig } from '../registry'

export type CommandResult = {
  command: string
  exitCode: number
  output: string
}
export const installationNetwork = {
  allow: Object.fromEntries(
    [
      'registry.npmjs.org',
      'registry.npmjs.com',
      'bun.sh',
      'github.com',
      'codeload.github.com',
      '*.githubusercontent.com',
      '*.playwright.dev',
      'cdn.playwright.dev',
      'playwright.download.prss.microsoft.com',
      'archive.ubuntu.com',
      'security.ubuntu.com',
      'deb.nodesource.com'
    ].map((domain) => [domain, []])
  )
}
export async function sandboxCommand(
  sandbox: Sandbox,
  command: string,
  cwd = '/vercel/sandbox/repo',
  deadline = Date.now() + 900_000
): Promise<CommandResult> {
  const seconds = Math.min(900, Math.floor((deadline - Date.now()) / 1000))
  if (seconds < 1) throw new Error('Incident execution deadline reached')
  const result = await sandbox.runCommand({
    cmd: 'bash',
    args: [
      '-lc',
      `export PATH="/tmp/runtime/node_modules/.bin:$HOME/.bun/bin:$PATH"; timeout ${seconds}s bash -c ${quote(command)}`
    ],
    cwd
  })
  return {
    command,
    exitCode: result.exitCode,
    output: sanitizeText(
      `${await result.stdout()}\n${await result.stderr()}`
    ).slice(-16_000)
  }
}
export async function startVerification(
  repo: RepositoryConfig,
  candidate: Candidate,
  deadline = Date.now() + 3_600_000
) {
  validateCandidate(candidate)
  const source = await createGitHubClient().source(repo, candidate.baseSha)
  const timeout = deadline - Date.now()
  if (timeout < 1000) throw new Error('Incident execution deadline reached')
  const sandbox = await Sandbox.create({
    timeout,
    persistent: false,
    resources: { vcpus: 4 },
    networkPolicy: installationNetwork
  })
  try {
    await sandbox.writeFiles([
      { path: 'source.tar.gz', content: source.archive },
      {
        path: 'regression.patch',
        content: Buffer.from(candidate.regressionPatch)
      },
      { path: 'repair.patch', content: Buffer.from(candidate.patch) }
    ])
    const init = await sandboxCommand(
      sandbox,
      'mkdir -p repo && tar -xzf source.tar.gz -C repo --strip-components=1 && git -C repo init -q && git -C repo add . && git -C repo -c user.name=Verifier -c user.email=verifier@localhost commit -qm baseline',
      '/vercel/sandbox'
    )
    if (init.exitCode !== 0)
      throw new Error('Verification source initialization failed')
    return { name: sandbox.name, commands: [init] }
  } catch (error) {
    await sandbox.stop()
    throw error
  }
}
export async function runVerificationCommand(
  name: string,
  command: string,
  deadline?: number
) {
  return sandboxCommand(
    await Sandbox.get({ name }),
    command,
    '/vercel/sandbox/repo',
    deadline
  )
}
export async function stopVerification(name: string) {
  await (await Sandbox.get({ name })).stop()
}
