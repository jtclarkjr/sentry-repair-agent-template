import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { RepositoryConfig } from '../registry'
import { sanitizeText } from '../redaction'
import { type GitHubClient, GitHubRequestError } from './client'
import { markerSignature } from './state'

export type ChangedFile = { path: string; content: string | null }

export async function publish(
  client: GitHubClient,
  repo: RepositoryConfig,
  issueId: string,
  baseSha: string,
  files: ChangedFile[],
  title: string,
  body: string
) {
  const root = `/repos/${repo.owner}/${repo.repo}`
  if (
    !/^\d+$/.test(issueId) ||
    !/^[a-f\d]{40}$/.test(baseSha) ||
    !files.length ||
    files.length > 100
  )
    throw new Error('Invalid publication inputs')
  const paths = new Set<string>()
  for (const file of files) {
    if (
      !file.path ||
      file.path.startsWith('/') ||
      file.path.includes('\\') ||
      file.path.includes('\0') ||
      file.path
        .split('/')
        .some((part) => part === '.' || part === '..' || part === '.git') ||
      paths.has(file.path)
    )
      throw new Error('Invalid or duplicate publication path')
    paths.add(file.path)
  }
  const digest = createHash('sha256')
    .update(
      JSON.stringify({
        repository: `${repo.owner}/${repo.repo}`,
        issueId,
        baseSha,
        files: [...files].sort((a, b) => a.path.localeCompare(b.path))
      })
    )
    .digest('hex')
  const branch = `branch/incident-${issueId}-${baseSha.slice(0, 12)}`
  const publicationMarker = `<!-- sentry-repair-publication:${digest}.${markerSignature(digest)} -->`
  const pullsPath = `${root}/pulls?state=all&head=${encodeURIComponent(`${repo.owner}:${branch}`)}&per_page=100`
  const info = await client.request<any>(repo, 'GET', root)
  const base = await client.request<any>(
    repo,
    'GET',
    `${root}/branches/${encodeURIComponent(info.default_branch)}`
  )
  if (base.commit.sha !== baseSha)
    throw new Error(
      'Default branch advanced during verification; verify the new base before publishing'
    )
  const prior = z
    .array(z.object({ ref: z.string() }))
    .max(100)
    .parse(
      await client.request(
        repo,
        'GET',
        `${root}/git/matching-refs/heads/branch/incident-${issueId}-`
      )
    )
  for (const ref of prior) {
    if (ref.ref === `refs/heads/${branch}`) continue
    const head = ref.ref.replace(/^refs\/heads\//, '')
    const pulls = await client.request<any[]>(
      repo,
      'GET',
      `${root}/pulls?state=all&head=${encodeURIComponent(`${repo.owner}:${head}`)}&per_page=100`
    )
    if (
      !pulls.length ||
      pulls.length >= 100 ||
      pulls.some((pr) => pr.state !== 'closed')
    )
      throw new Error(
        'An open or partial prior-base repair branch requires manual reconciliation before another publication'
      )
  }
  const commit = await client.request<any>(
    repo,
    'GET',
    `${root}/git/commits/${baseSha}`
  )
  const tree = await client.request<any>(repo, 'POST', `${root}/git/trees`, {
    base_tree: commit.tree.sha,
    tree: files.map((file) =>
      file.content === null
        ? { path: file.path, mode: '100644', type: 'blob', sha: null }
        : {
            path: file.path,
            mode: '100644',
            type: 'blob',
            content: file.content
          }
    )
  })
  const validateCommit = async (commitSha: string) => {
    const existing = await client.request<any>(
      repo,
      'GET',
      `${root}/git/commits/${commitSha}`
    )
    if (
      existing.tree?.sha !== tree.sha ||
      existing.parents?.length !== 1 ||
      existing.parents[0].sha !== baseSha ||
      !existing.message?.includes(publicationMarker)
    )
      throw new Error(
        'Existing repair branch no longer matches the verified changes'
      )
    return { sha: commitSha }
  }
  const reconcilePull = async () => {
    const rows = await client.request<any[]>(repo, 'GET', pullsPath)
    if (!rows.length) return null
    if (rows.length !== 1)
      throw new Error(
        'Multiple repair pull requests require manual reconciliation'
      )
    const pr = rows[0]
    if (
      pr.state !== 'open' ||
      pr.draft ||
      pr.head?.ref !== branch ||
      pr.head?.repo?.full_name !== `${repo.owner}/${repo.repo}` ||
      pr.base?.ref !== info.default_branch ||
      !pr.body?.includes(publicationMarker)
    )
      throw new Error('Existing repair pull request requires manual review')
    await validateCommit(pr.head.sha)
    return {
      url: z.url({ protocol: /^https$/ }).parse(pr.html_url),
      existing: true
    }
  }
  const existingPull = await reconcilePull()
  if (existingPull) return existingPull
  let next: { sha: string } | undefined
  let branchExists = false
  try {
    const ref = await client.request<any>(
      repo,
      'GET',
      `${root}/git/ref/heads/${branch}`
    )
    next = await validateCommit(ref.object.sha)
    branchExists = true
  } catch (error) {
    if (!(error instanceof GitHubRequestError) || error.status !== 404)
      throw error
  }
  next ??= await client.request<any>(repo, 'POST', `${root}/git/commits`, {
    message: `${sanitizeText(title)}\n\n${publicationMarker}`,
    tree: tree.sha,
    parents: [baseSha]
  })
  if (!branchExists)
    try {
      await client.request(repo, 'POST', `${root}/git/refs`, {
        ref: `refs/heads/${branch}`,
        sha: next!.sha
      })
    } catch (error) {
      const ref = await client.request<any>(
        repo,
        'GET',
        `${root}/git/ref/heads/${branch}`
      )
      await validateCommit(ref.object.sha)
    }
  try {
    const pr = await client.request<any>(repo, 'POST', `${root}/pulls`, {
      title: sanitizeText(title),
      body: `${sanitizeText(body)}\n\n${publicationMarker}`,
      head: branch,
      base: info.default_branch,
      draft: false
    })
    return {
      url: z.url({ protocol: /^https$/ }).parse(pr.html_url),
      existing: false
    }
  } catch (error) {
    const recovered = await reconcilePull()
    if (recovered) return recovered
    throw error
  }
}
