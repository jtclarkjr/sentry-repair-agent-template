import { pathToFileURL } from 'node:url'

export function githubAppSetup(deploymentOrigin: string) {
  const origin = new URL(deploymentOrigin)
  if (
    origin.protocol !== 'https:' ||
    origin.username ||
    origin.password ||
    origin.pathname !== '/' ||
    origin.search ||
    origin.hash
  ) {
    throw new Error(
      'Pass an HTTPS deployment origin without a path, query, or credentials.'
    )
  }

  const manifest = {
    name: 'Sentry Repair Agent',
    url: origin.origin,
    description:
      'Investigate production incidents and publish independently verified fixes for human review.',
    public: false,
    hook_attributes: { url: `${origin.origin}/github`, active: false },
    default_permissions: {
      contents: 'write',
      issues: 'write',
      pull_requests: 'write',
      checks: 'read',
      metadata: 'read'
    },
    default_events: [],
    request_oauth_on_install: false
  }

  const registration = new URL('https://github.com/settings/apps/new')
  registration.searchParams.set('name', manifest.name)
  registration.searchParams.set('url', manifest.url)
  registration.searchParams.set('description', manifest.description)
  registration.searchParams.set('public', 'false')
  registration.searchParams.set('webhook_active', 'false')
  for (const [permission, access] of Object.entries(
    manifest.default_permissions
  )) {
    registration.searchParams.set(permission, access)
  }

  return { manifest, registration: registration.toString() }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.length !== 3)
    throw new Error('Usage: bun run github-app https://your-agent.example.com')
  const setup = githubAppSetup(process.argv[2])
  console.log(JSON.stringify(setup.manifest, null, 2))
  console.error(
    `\nManual registration with these settings prefilled:\n${setup.registration}\n\nCreate your own private App and choose a globally unique App name in the registration form. This link opens personal-account registration; for organization repositories, use the owning organization’s Settings > Developer settings > GitHub Apps > New GitHub App with the same settings. Register under the account or organization owning your monitored repositories: private Apps install only on their owner’s account. All registry repositories must belong to this one GITHUB_INSTALLATION_ID. Install only on repositories configured in agent/lib/registry.ts. Store the generated private key directly in protected Vercel environment variables.`
  )
}
