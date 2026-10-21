import { timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { RepositoryConfig } from '../registry'
import { type GitHubClient, GitHubRequestError } from './client'
import { markerSignature } from './state'

const leaseSchema = z.object({
  kind: z.literal('repository-lease'),
  version: z.literal(1),
  repository: z.string(),
  owner: z.string().min(1).max(300),
  baseSha: z.string().regex(/^[a-f\d]{40}$/)
})

async function readLease(
  client: GitHubClient,
  repo: RepositoryConfig
) {
  const root = `/repos/${repo.owner}/${repo.repo}`
  let ref: any
  try {
    ref = await client.request<any>(
      repo,
      'GET',
      `${root}/git/ref/tags/incident-agent-lock`
    )
  } catch (error) {
    if (error instanceof GitHubRequestError && error.status === 404)
      return null
    throw error
  }
  if (ref.object?.type !== 'commit' || !/^[a-f\d]{40}$/.test(ref.object?.sha))
    throw new Error('Repository lease is invalid; manual cleanup is required')
  const commit = await client.request<any>(
    repo,
    'GET',
    `${root}/git/commits/${ref.object.sha}`
  )
  const match =
    typeof commit.message === 'string' &&
    commit.message.match(
      /<!-- sentry-repair-lease:([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+) -->/
    )
  if (!match || match[1].length > 6_000)
    throw new Error(
      'Repository lease cannot be authenticated; manual cleanup is required'
    )
  const expected = Buffer.from(markerSignature(match[1]))
  const received = Buffer.from(match[2])
  if (
    expected.length !== received.length ||
    !timingSafeEqual(expected, received)
  )
    throw new Error(
      'Repository lease cannot be authenticated; manual cleanup is required'
    )
  const lease = leaseSchema.parse(
    JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8'))
  )
  if (
    lease.repository !== `${repo.owner}/${repo.repo}` ||
    commit.parents?.length !== 1 ||
    commit.parents[0].sha !== lease.baseSha
  )
    throw new Error(
      'Repository lease is outside the configured scope; manual cleanup is required'
    )
  return lease
}
/** The lightweight tag is atomic and never stolen; abandoned owners require manual cleanup. */
export async function acquireLease(
  client: GitHubClient,
  repo: RepositoryConfig,
  owner: string,
  baseSha: string
): Promise<boolean> {
  const lease = leaseSchema.parse({
    kind: 'repository-lease',
    version: 1,
    repository: `${repo.owner}/${repo.repo}`,
    owner,
    baseSha
  })
  const existing = await readLease(client, repo)
  if (existing) return existing.owner === owner
  const root = `/repos/${repo.owner}/${repo.repo}`
  const base = await client.request<any>(
    repo,
    'GET',
    `${root}/git/commits/${baseSha}`
  )
  const value = Buffer.from(JSON.stringify(lease)).toString('base64url')
  const commit = await client.request<any>(
    repo,
    'POST',
    `${root}/git/commits`,
    {
      message: `Incident agent repository lease\n\n<!-- sentry-repair-lease:${value}.${markerSignature(value)} -->`,
      tree: z
        .string()
        .regex(/^[a-f\d]{40}$/)
        .parse(base.tree?.sha),
      parents: [baseSha]
    }
  )
  try {
    await client.request(repo, 'POST', `${root}/git/refs`, {
      ref: 'refs/tags/incident-agent-lock',
      sha: z
        .string()
        .regex(/^[a-f\d]{40}$/)
        .parse(commit.sha)
    })
    return true
  } catch (error) {
    const recovered = await readLease(client, repo)
    if (recovered) return recovered.owner === owner
    throw error
  }
}
export async function releaseLease(
  client: GitHubClient,
repo: RepositoryConfig, owner: string): Promise<boolean> {
  const existing = await readLease(client, repo)
  if (!existing) return true
  if (existing.owner !== owner) return false
  try {
    await client.request(
      repo,
      'DELETE',
      `/repos/${repo.owner}/${repo.repo}/git/refs/tags/incident-agent-lock`
    )
  } catch (error) {
    if (error instanceof GitHubRequestError && error.status === 404)
      return true
    const recovered = await readLease(client, repo)
    if (!recovered) return true
    if (recovered.owner !== owner) return false
    throw error
  }
  return true
}
