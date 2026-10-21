import { expect, test } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { githubAppSetup } from '../github-app-manifest'

test('registration requests a private repository App without workflow writes', () => {
  const setup = githubAppSetup('https://repair.example.com')
  const url = new URL(setup.registration)
  expect(setup.manifest.public).toBe(false)
  expect(setup.manifest.hook_attributes.active).toBe(false)
  expect(url.origin).toBe('https://github.com')
  expect(url.searchParams.get('contents')).toBe('write')
  expect(url.searchParams.has('workflows')).toBe(false)
  expect(url.searchParams.get('webhook_active')).toBe('false')
})

test('registration rejects credential-bearing URLs and callback paths', () => {
  for (const value of [
    'http://example.com',
    'https://name:secret@example.com',
    'https://example.com/path',
    'https://example.com?key=secret'
  ]) {
    expect(() => githubAppSetup(value)).toThrow()
  }
})


test('CLI requires one explicit deployment origin', () => {
  const script = fileURLToPath(new URL('../github-app-manifest.ts', import.meta.url))
  for (const args of [[], ['https://repair.example.com', 'extra']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('Usage: bun run github-app')
    expect(result.stdout).toBe('')
  }
  const result = spawnSync(process.execPath, [script, 'https://repair.example.com'], { encoding: 'utf8' })
  expect(result.status).toBe(0)
  expect(JSON.parse(result.stdout).url).toBe('https://repair.example.com')
  expect(result.stderr).toContain('Create your own private App')
  expect(result.stderr).toContain('globally unique App name')
  expect(result.stderr).toContain('one GITHUB_INSTALLATION_ID')
})
