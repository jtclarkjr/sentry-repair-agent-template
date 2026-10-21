export type CriticalFlow = { id: string; name: string; main: boolean }
export type RolloutGate = {
  status: 'pending' | 'verified'
  evidence: string
  sha?: string
}
export type RepositoryConfig = {
  id: string
  owner: string
  repo: string
  baseBranch: string
  projects: readonly { org: string; slug: string; id: string }[]
  projectId: string
  vercelProjectId: string
  vercelTeamId: string
  environments: readonly string[]
  repairReadiness: { baseline: RolloutGate; sourceMaps: RolloutGate }
  testEnvironment: Readonly<Record<string, string>>
  browserVerification: 'report-only' | 'enabled'
  setupCommands: readonly string[]
  checkCommands: readonly string[]
  criticalFlows: readonly CriticalFlow[]
  model: string
}

export const repositories: readonly RepositoryConfig[] = [
  {
    id: 'example-app',
    owner: 'your-github-org',
    repo: 'your-app',
    baseBranch: 'main',
    projects: [
      { org: 'your-sentry-org', slug: 'your-sentry-project', id: '1234567890' }
    ],
    projectId: '1234567890',
    vercelProjectId: 'prj_your_project_id',
    vercelTeamId: 'team_your_team_id',
    environments: ['production'],
    browserVerification: 'report-only',
    repairReadiness: {
      baseline: {
        status: 'pending',
        evidence: 'Run all configured checks against a clean source archive and record the verified commit SHA.'
      },
      sourceMaps: {
        status: 'pending',
        evidence: 'Verify production source maps and the full GitHub release SHA for this repository.'
      }
    },
    testEnvironment: {},
    setupCommands: ['bun install --frozen-lockfile --ignore-scripts'],
    checkCommands: ['bun run test', 'bun run typecheck', 'bun run build'],
    criticalFlows: [
      { id: 'main-flow', name: 'Complete the primary application operation', main: true }
    ],
    model: 'openai/gpt-6.1-sol'
  }
]

export function getRepositoryByProject(
  org: string,
  project: string
): RepositoryConfig | undefined {
  return repositories.find((repository) =>
    repository.projects.some(
      (entry) =>
        entry.org === org && (entry.slug === project || entry.id === project)
    )
  )
}

export function getRepository(id: string): RepositoryConfig {
  const repo = repositories.find((repo) => repo.id === id)
  if (!repo) throw new Error('Unknown repository')
  return repo
}
