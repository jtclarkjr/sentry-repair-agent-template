import { createPrivateKey, sign } from 'node:crypto'
import { z } from 'zod'
import type { RepositoryConfig } from '../registry'

export class GitHubRequestError extends Error {
  constructor(
    readonly status: number,
    method: string
  ) {
    super(`GitHub ${method} failed (${status})`)
  }
}

export class GitHubClient {
  constructor(private fetcher: typeof fetch = fetch) {}
  async installationToken(repo: RepositoryConfig): Promise<string> {
    const id = process.env.GITHUB_APP_ID
    const installation = process.env.GITHUB_INSTALLATION_ID
    const pem = process.env.GITHUB_APP_PRIVATE_KEY?.replace(/\\n/g, '\n')
    if (!id || !installation || !pem)
      throw new Error(
        'Configure GitHub App credentials before enabling monitoring'
      )
    const now = Math.floor(Date.now() / 1000)
    const payload = [
      Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString(
        'base64url'
      ),
      Buffer.from(
        JSON.stringify({ iat: now - 30, exp: now + 300, iss: id })
      ).toString('base64url')
    ].join('.')
    const jwt = `${payload}.${sign('RSA-SHA256', Buffer.from(payload), createPrivateKey(pem)).toString('base64url')}`
    const response = await this.fetcher(
      `https://api.github.com/app/installations/${encodeURIComponent(installation)}/access_tokens`,
      {
        method: 'POST',
        headers: this.headers(jwt),
        body: JSON.stringify({
          repositories: [repo.repo],
          permissions: {
            contents: 'write',
            issues: 'write',
            pull_requests: 'write'
          }
        }),
        signal: AbortSignal.timeout(30_000),
        redirect: 'error'
      }
    )
    if (!response.ok)
      throw new Error(`GitHub App authentication failed (${response.status})`)
    return z.object({ token: z.string().min(1) }).parse(await response.json())
      .token
  }
  private headers(token: string) {
    return {
      authorization: `Bearer ${token}`,
      accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'content-type': 'application/json'
    }
  }
  async request<T = any>(
    repo: RepositoryConfig,
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = new URL(path, 'https://api.github.com')
    const root = `/repos/${repo.owner}/${repo.repo}`
    if (
      url.origin !== 'https://api.github.com' ||
      (!url.pathname.startsWith(`${root}/`) && url.pathname !== root) ||
      /%(?:2f|5c|2e)/i.test(url.pathname)
    )
      throw new Error('GitHub request outside configured repository')
    const response = await this.fetcher(`https://api.github.com${path}`, {
      method,
      headers: this.headers(await this.installationToken(repo)),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(30_000),
      redirect: 'error'
    })
    if (!response.ok) throw new GitHubRequestError(response.status, method)
    return response.status === 204
      ? (undefined as T)
      : ((await response.json()) as T)
  }
  async source(
    repo: RepositoryConfig,
    revision?: string
  ): Promise<{ sha: string; archive: Buffer; baseBranch: string }> {
    const info = await this.request<any>(
      repo,
      'GET',
      `/repos/${repo.owner}/${repo.repo}`
    )
    const branch = await this.request<any>(
      repo,
      'GET',
      `/repos/${repo.owner}/${repo.repo}/branches/${encodeURIComponent(info.default_branch)}`
    )
    const sha = z
      .string()
      .regex(/^[a-f0-9]{40}$/)
      .parse(revision ?? branch.commit.sha)
    let response = await this.fetcher(
      `https://api.github.com/repos/${repo.owner}/${repo.repo}/tarball/${sha}`,
      {
        headers: this.headers(await this.installationToken(repo)),
        signal: AbortSignal.timeout(60_000),
        redirect: 'manual'
      }
    )
    if (response.status === 302 || response.status === 307) {
      const target = new URL(
        response.headers.get('location') ?? '',
        'https://api.github.com'
      )
      await response.body?.cancel()
      if (
        target.origin !== 'https://codeload.github.com' ||
        target.username ||
        target.password ||
        !target.pathname.startsWith(`/${repo.owner}/${repo.repo}/`)
      )
        throw new Error(
          'GitHub archive redirect outside the configured repository'
        )
      response = await this.fetcher(target, {
        signal: AbortSignal.timeout(60_000),
        redirect: 'error'
      })
    }
    if (!response.ok)
      throw new Error(`GitHub source download failed (${response.status})`)
    if (Number(response.headers.get('content-length')) > 40_000_000) {
      await response.body?.cancel()
      throw new Error('Source archive exceeds 40 MB')
    }
    const reader = response.body?.getReader()
    if (!reader) throw new Error('GitHub source archive body missing')
    const chunks: Uint8Array[] = []
    let length = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        length += value.byteLength
        if (length > 40_000_000) throw new Error('Source archive exceeds 40 MB')
        chunks.push(value)
      }
    } finally {
      await reader.cancel()
    }
    const archive = Buffer.concat(chunks, length)
    return { sha, archive, baseBranch: info.default_branch }
  }
}
export const createGitHubClient = () => new GitHubClient()
