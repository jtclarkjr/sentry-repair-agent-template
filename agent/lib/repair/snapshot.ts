import { Sandbox } from '@vercel/sandbox'
import { createHash } from 'node:crypto'
import { type ChangedFile } from '../github/publish'
import { safePath } from './candidate'

export type CandidateSnapshot = { files: ChangedFile[]; hash: string }

const generatedArtifact = (path: string) =>
  path.startsWith('reports/') || path.startsWith('graphify-out/')
const repositoryFingerprintScript = `
const { execFileSync } = require('node:child_process');
const { lstatSync, readFileSync, readlinkSync } = require('node:fs');
const { createHash } = require('node:crypto');
const hash = createHash('sha256');
hash.update(execFileSync('/usr/bin/git', ['rev-parse', 'HEAD']));
const paths = execFileSync('/usr/bin/git', ['ls-files', '-z'], { maxBuffer: 4000000 }).toString('utf8').split('\\0').filter(Boolean).sort();
let bytes = 0;
for (const path of paths) {
  if (path.startsWith('reports/') || path.startsWith('graphify-out/')) continue;
  hash.update(path + '\\0');
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === 'ENOENT') { hash.update('missing\\0'); continue; } throw error; }
  hash.update(String(stat.mode) + '\\0');
  if (stat.isSymbolicLink()) { hash.update(readlinkSync(path)); continue; }
  if (!stat.isFile()) throw new Error('Non-file tracked source');
  bytes += stat.size;
  if (bytes > 250000000) throw new Error('Source fingerprint limit exceeded');
  hash.update(createHash('sha256').update(readFileSync(path)).digest());
}
process.stdout.write(hash.digest('hex'));
`

/** Freeze candidate bytes and the complete tracked source tree, excluding generated report artifacts. */
export async function snapshotCandidate(
  name: string,
  expectedPaths: string[]
): Promise<CandidateSnapshot> {
  if (
    !expectedPaths.length ||
    expectedPaths.length > 30 ||
    new Set(expectedPaths).size !== expectedPaths.length ||
    expectedPaths.some((path) => !safePath(path))
  )
    throw new Error('Unsafe publication paths')
  const sandbox = await Sandbox.get({ name })
  // Git diff omits untracked additions; inspect them separately without staging deleted paths.
  const raw = await sandbox.runCommand({
    cmd: '/usr/bin/git',
    args: ['diff', 'HEAD', '--name-only', '-z'],
    cwd: '/vercel/sandbox/repo'
  })
  const untracked = await sandbox.runCommand({
    cmd: '/usr/bin/git',
    args: ['ls-files', '--others', '--exclude-standard', '-z'],
    cwd: '/vercel/sandbox/repo'
  })
  if (raw.exitCode !== 0 || untracked.exitCode !== 0)
    throw new Error('Could not inspect verified file changes')
  const paths = [
    ...new Set(
      `${await raw.stdout()}${await untracked.stdout()}`
        .split('\0')
        .filter(Boolean)
    )
  ]
  if (
    expectedPaths.some((path) => !paths.includes(path)) ||
    paths.some(
      (path) => !expectedPaths.includes(path) && !generatedArtifact(path)
    )
  )
    throw new Error('Verified patch differs from the approved paths')
  const files: ChangedFile[] = []
  let size = 0
  let actualSize = 0
  for (const path of [...expectedPaths].sort()) {
    const stat = await sandbox.runCommand({
      cmd: '/usr/bin/stat',
      args: ['-c', '%s:%f', '--', path],
      cwd: '/vercel/sandbox/repo'
    })
    if (stat.exitCode === 0) {
      const match = (await stat.stdout()).trim().match(/^(\d+):([a-f\d]+)$/i)
      if (!match) throw new Error('Could not inspect candidate file metadata')
      const mode = Number.parseInt(match[2], 16)
      if ((mode & 0xf000) !== 0x8000 || (mode & 0o111) !== 0)
        throw new Error(
          'Candidate files must remain regular non-executable files'
        )
      size += Number(match[1])
      if (size > 500_000)
        throw new Error('Verified patch exceeds text publication limits')
    }
    const content = await sandbox.readFileToBuffer({
      path: `/vercel/sandbox/repo/${path}`
    })
    actualSize += content?.length ?? 0
    if (actualSize > 500_000)
      throw new Error('Verified patch exceeds text publication limits')
    if (stat.exitCode !== 0 && content !== undefined && content !== null)
      throw new Error('Could not inspect candidate file metadata')
    if (
      content?.includes(0) ||
      (content && !Buffer.from(content.toString('utf8')).equals(content))
    )
      throw new Error('Verified patch must contain UTF-8 text')
    files.push({ path, content: content?.toString('utf8') ?? null })
  }
  const fingerprint = await sandbox.runCommand({
    cmd: 'node',
    args: ['-e', repositoryFingerprintScript],
    cwd: '/vercel/sandbox/repo'
  })
  const trackedHash = (await fingerprint.stdout()).trim()
  if (fingerprint.exitCode !== 0 || !/^[a-f\d]{64}$/.test(trackedHash))
    throw new Error('Could not fingerprint verification source')
  return {
    files,
    hash: createHash('sha256')
      .update(trackedHash)
      .update(JSON.stringify(files))
      .digest('hex')
  }
}

export async function collectVerifiedFiles(
  name: string,
  expectedPaths: string[],
  expectedHash?: string
): Promise<ChangedFile[]> {
  const current = await snapshotCandidate(name, expectedPaths)
  if (expectedHash !== undefined && current.hash !== expectedHash)
    throw new Error(
      'Verification changed the frozen candidate or tracked source; publication refused'
    )
  return current.files
}
