import { createPrivateKey } from 'node:crypto'
import { pathToFileURL } from 'node:url'

type Check = { name: string; ok: boolean; detail: string }

export function checkEnvironment(env: NodeJS.ProcessEnv): Check[] {
  const checks: Check[] = []
  for (const name of [
    'SENTRY_AUTH_TOKEN',
    'SENTRY_WEBHOOK_SECRET',
    'GITHUB_APP_ID',
    'GITHUB_INSTALLATION_ID',
    'GITHUB_APP_PRIVATE_KEY',
    'CRON_SECRET',
    'STATE_SIGNING_SECRET'
  ]) {
    const value = env[name]?.trim()
    checks.push({
      name,
      ok: Boolean(value),
      detail: value ? 'configured' : 'missing'
    })
  }
  for (const name of ['GITHUB_APP_ID', 'GITHUB_INSTALLATION_ID']) {
    if (env[name]?.trim())
      checks.push({
        name: `${name} format`,
        ok: /^[1-9]\d*$/.test(env[name]!.trim()),
        detail: 'must be a positive numeric ID'
      })
  }
  if (env.GITHUB_APP_PRIVATE_KEY?.trim()) {
    let valid = false
    try {
      valid =
        createPrivateKey(env.GITHUB_APP_PRIVATE_KEY.replaceAll('\\n', '\n'))
          .asymmetricKeyType === 'rsa'
    } catch {
      // Credential parsing errors may contain secret input; report only the status.
    }
    checks.push({
      name: 'GitHub signing key',
      ok: valid,
      detail: valid ? 'valid RSA private key' : 'invalid RSA private key'
    })
  }
  if (env.CRON_SECRET?.trim())
    checks.push({
      name: 'Cron authentication',
      ok: env.CRON_SECRET.length >= 32,
      detail: 'use at least 32 random characters'
    })
  if (env.STATE_SIGNING_SECRET?.trim())
    checks.push({
      name: 'State signing',
      ok:
        env.STATE_SIGNING_SECRET.length >= 32 &&
        env.STATE_SIGNING_SECRET !== env.CRON_SECRET,
      detail:
        'use at least 32 independent random characters; preserve this key across Cron rotation'
    })
  checks.push({
    name: 'MONITOR_ENABLED',
    ok: env.MONITOR_ENABLED === 'false' || env.MONITOR_ENABLED === 'true',
    detail:
      env.MONITOR_ENABLED === 'true'
        ? 'enabled; activation evidence must already be recorded'
        : 'must be explicitly false until activation checks pass'
  })
  return checks
}

async function readJson(
  url: string,
  headers: Record<string, string> = {}
): Promise<unknown> {
  const response = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20_000),
    redirect: 'error'
  })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  return response.json()
}

export async function preflight(live: boolean): Promise<boolean> {
  const checks = checkEnvironment(process.env)
  const run = async (name: string, operation: () => Promise<void>) => {
    try {
      await operation()
      checks.push({ name, ok: true, detail: 'read-only check passed' })
    } catch (error) {
      const status =
        error instanceof Error && /^HTTP \d+$/.test(error.message)
          ? ` (${error.message})`
          : ''
      checks.push({
        name,
        ok: false,
        detail: `failed${status}; inspect permissions/configuration without logging credentials`
      })
    }
  }
  if (live && checks.every((check) => check.ok)) {
    const { repositories } = await import('../agent/lib/registry.js')
    const { createGitHubClient } = await import('../agent/lib/github/client.js')
    const github = createGitHubClient()
    for (const repo of repositories) {
      await run(
        `${repo.owner}/${repo.repo}: GitHub App repository access`,
        async () => {
          await github.request(repo, 'GET', `/repos/${repo.owner}/${repo.repo}`)
        }
      )
      for (const project of repo.projects) {
        await run(`${project.slug}: Sentry issue/event read`, async () => {
          const issues = await readJson(
            `https://sentry.io/api/0/projects/${encodeURIComponent(project.org)}/${encodeURIComponent(project.slug)}/issues/?limit=1&query=is%3Aunresolved`,
            {
              Authorization: `Bearer ${process.env.SENTRY_AUTH_TOKEN}`
            }
          )
          if (!Array.isArray(issues)) throw new Error('Invalid Sentry response')
        })
      }
      if (process.env.VERCEL_READ_TOKEN) {
        await run(`${repo.id}: Vercel metadata`, async () => {
          await readJson(
            `https://api.vercel.com/v9/projects/${encodeURIComponent(repo.vercelProjectId)}?teamId=${encodeURIComponent(repo.vercelTeamId)}`,
            { Authorization: `Bearer ${process.env.VERCEL_READ_TOKEN}` }
          )
        })
      }
    }
    await run('AI Gateway model catalog', async () => {
      const result = (await readJson(
        'https://ai-gateway.vercel.sh/v1/models'
      )) as { data?: { id?: string }[] }
      if (!result.data?.some((model) => model.id === 'openai/gpt-6.1-sol'))
        throw new Error('Configured model unavailable')
    })
  }
  for (const check of checks)
    console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}: ${check.detail}`)
  console.log(
    'No model call, sandbox, issue, or PR was created. Budget, source maps, baselines, signed delivery, and controlled incidents require separate activation evidence.'
  )
  if (!process.env.VERCEL_READ_TOKEN)
    console.log(
      'NOTE VERCEL_READ_TOKEN missing: optional deployment/log evidence unavailable.'
    )
  return checks.every((check) => check.ok)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.slice(2).some((arg) => arg !== '--live'))
    throw new Error('Usage: bun run scripts/preflight.ts [--live]')
  process.exitCode = (await preflight(process.argv.includes('--live'))) ? 0 : 1
}
