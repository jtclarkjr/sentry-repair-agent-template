import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import type { RepositoryConfig } from '../registry'
import { sanitizeText } from '../redaction'
import { type GitHubClient, GitHubRequestError } from './client'
import {
  decodeMarker,
  encodeMarker,
  markerSignature,
  type IncidentMarker
} from './state'

const reportIntentSchema = z.object({
  kind: z.literal('incident-report-create'),
  version: z.literal(1),
  repository: z.string(),
  org: z.string(),
  project: z.string(),
  issueId: z.string()
})
export type ReportRecord = {
  number: number
  html_url: string
  body: string
  marker: IncidentMarker
}

export async function reports(
  client: GitHubClient,
  repo: RepositoryConfig
): Promise<ReportRecord[]> {
  const found: ReportRecord[] = []
  for (let page = 1; page <= 20; page++) {
    const rows = await client.request<any[]>(
      repo,
      'GET',
      `/repos/${repo.owner}/${repo.repo}/issues?state=all&per_page=100&page=${page}`
    )
    for (const row of rows) {
      if (row.pull_request) continue
      const marker = decodeMarker(row.body ?? '')
      if (
        !marker &&
        /<!-- sentry-repair-agent:[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+ -->/.test(
          row.body ?? ''
        )
      )
        throw new Error(
          'Signed report state cannot be authenticated; restore STATE_SIGNING_SECRET or reconcile manually'
        )
      if (
        marker &&
        marker.repository === `${repo.owner}/${repo.repo}` &&
        repo.projects.some(
          (project) =>
            project.org === marker.org && project.slug === marker.project
        )
      )
        found.push({
          number: row.number,
          html_url: row.html_url,
          body: row.body,
          marker
        })
    }
    if (rows.length < 100) {
      const identities = found.map(
        (row) =>
          `${row.marker.org}/${row.marker.project}/${row.marker.issueId}`
      )
      if (new Set(identities).size !== identities.length)
        throw new Error(
          'Duplicate signed incident reports require manual reconciliation'
        )
      return found
    }
  }
  throw new Error(
    'GitHub report scan incomplete; refusing duplicate-prone publication'
  )
}
export async function upsertReport(
  client: GitHubClient,
  repo: RepositoryConfig,
  title: string,
  body: string,
  marker: IncidentMarker,
  existingReportNumber?: number
): Promise<ReportRecord> {
  const project = repo.projects.find(
    (project) => project.slug === marker.project
  )
  if (!project)
    throw new Error('Incident report is outside the configured project')
  marker = {
    ...marker,
    repository: `${repo.owner}/${repo.repo}`,
    org: project.org
  }
  let previous: ReportRecord | undefined
  if (existingReportNumber !== undefined) {
    if (
      !Number.isSafeInteger(existingReportNumber) ||
      existingReportNumber < 1
    )
      throw new Error('Invalid existing incident report number')
    const row = await client.request<any>(
      repo,
      'GET',
      `/repos/${repo.owner}/${repo.repo}/issues/${existingReportNumber}`
    )
    const owned = decodeMarker(row.body ?? '')
    if (
      row.number !== existingReportNumber ||
      row.pull_request ||
      !owned ||
      owned.repository !== marker.repository ||
      owned.org !== marker.org ||
      owned.project !== marker.project ||
      owned.issueId !== marker.issueId
    )
      throw new Error(
        'Existing incident report ownership could not be authenticated'
      )
    previous = {
      number: row.number,
      html_url: row.html_url,
      body: row.body,
      marker: owned
    }
  } else {
    previous = (await reports(client, repo)).find(
      (row) =>
        row.marker.issueId === marker.issueId &&
        row.marker.project === marker.project &&
        row.marker.org === project.org
    )
  }
  if (!previous && !(await claimReportCreation(client, repo, marker))) {
    previous = await reconcileReport(client, repo, marker)
    if (!previous)
      throw new Error(
        'Incident report creation is reserved but no signed issue is visible; retry reconciliation or recover the reservation manually'
      )
  }
  const content = `${sanitizeText(body).slice(0, 45_000)}\n\n${encodeMarker(marker)}`
  const path = `/repos/${repo.owner}/${repo.repo}/issues${previous ? `/${previous.number}` : ''}`
  let row: any
  try {
    row = await client.request<any>(repo, previous ? 'PATCH' : 'POST', path, {
      title: sanitizeText(title).slice(0, 240),
      body: content
    })
  } catch (error) {
    if (previous) throw error
    const recovered = await reconcileReport(client, repo, marker)
    if (!recovered)
      throw new Error(
        'Incident report creation outcome is unknown; its permanent reservation prevents another POST until reconciliation or manual recovery'
      )
    return upsertReport(client, repo, title, body, marker, recovered.number)
  }
  if (
    !Number.isSafeInteger(row.number) ||
    row.number < 1 ||
    (previous && row.number !== previous.number)
  )
    throw new Error(
      'GitHub incident report response has an invalid issue number'
    )
  return { number: row.number, html_url: row.html_url, body: content, marker }
}
async function reconcileReport(
  client: GitHubClient,
  repo: RepositoryConfig,
  marker: IncidentMarker
) {
  // Lists can briefly omit a just-created issue. An existing intent never
  // authorizes another POST, including after a worker crash or a new client.
  for (let attempt = 0; attempt < 3; attempt++) {
    const found = (await reports(client, repo)).find(
      (row) =>
        row.marker.org === marker.org &&
        row.marker.project === marker.project &&
        row.marker.issueId === marker.issueId
    )
    if (found) return found
  }
  return undefined
}
async function claimReportCreation(
  client: GitHubClient,
  repo: RepositoryConfig,
  marker: IncidentMarker
) {
  const intent = reportIntentSchema.parse({
    kind: 'incident-report-create',
    version: 1,
    repository: marker.repository,
    org: marker.org,
    project: marker.project,
    issueId: marker.issueId
  })
  const root = `/repos/${repo.owner}/${repo.repo}`
  const name = `incident-agent-report-${createHash('sha256').update(JSON.stringify(intent)).digest('hex').slice(0, 32)}`
  const read = async () => {
    let ref: any
    try {
      ref = await client.request(repo, 'GET', `${root}/git/ref/tags/${name}`)
    } catch (error) {
      if (error instanceof GitHubRequestError && error.status === 404)
        return false
      throw error
    }
    if (
      ref.object?.type !== 'commit' ||
      !/^[a-f\d]{40}$/.test(ref.object?.sha)
    )
      throw new Error(
        'Incident report reservation is invalid; manual recovery required'
      )
    const commit = await client.request<any>(
      repo,
      'GET',
      `${root}/git/commits/${ref.object.sha}`
    )
    const match = String(commit.message).match(
      /<!-- sentry-repair-report-intent:([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+) -->/
    )
    const expected = match
      ? Buffer.from(markerSignature(match[1]!))
      : Buffer.alloc(0)
    const received = Buffer.from(match?.[2] ?? '')
    if (
      !match ||
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    )
      throw new Error(
        'Incident report reservation signature is invalid; manual recovery required'
      )
    let decoded: unknown
    try {
      decoded = JSON.parse(Buffer.from(match[1]!, 'base64url').toString())
    } catch {
      throw new Error(
        'Incident report reservation is malformed; manual recovery required'
      )
    }
    const parsed = reportIntentSchema.safeParse(decoded)
    if (
      !parsed.success ||
      JSON.stringify(parsed.data) !== JSON.stringify(intent)
    )
      throw new Error(
        'Incident report reservation scope does not match; manual recovery required'
      )
    return true
  }
  if (await read()) return false
  const info = await client.request<any>(repo, 'GET', root)
  const branch = await client.request<any>(
    repo,
    'GET',
    `${root}/branches/${encodeURIComponent(info.default_branch)}`
  )
  const baseSha = z
    .string()
    .regex(/^[a-f\d]{40}$/)
    .parse(branch.commit.sha)
  const base = await client.request<any>(
    repo,
    'GET',
    `${root}/git/commits/${baseSha}`
  )
  const value = Buffer.from(JSON.stringify(intent)).toString('base64url')
  const commit = await client.request<any>(
    repo,
    'POST',
    `${root}/git/commits`,
    {
      message: `Reserve one incident report creation\n\n<!-- sentry-repair-report-intent:${value}.${markerSignature(value)} -->`,
      tree: z.string().min(1).parse(base.tree?.sha),
      parents: [baseSha]
    }
  )
  const sha = z
    .string()
    .regex(/^[a-f\d]{40}$/)
    .parse(commit.sha)
  try {
    await client.request(repo, 'POST', `${root}/git/refs`, {
      ref: `refs/tags/${name}`,
      sha
    })
    // Keep the intent after success: a crash before the caller persists the
    // returned issue number must still prohibit a second creation.
    return true
  } catch (error) {
    if (await read()) return false
    throw error
  }
}
