import { repositories } from '../../registry'
import type { IncidentEvidence } from '../../incidents/model'

export const repository = repositories[0]!
export const project = repository.projects[0]!
export const end = '2026-10-21T04:00:00.000Z'
export const start = '2026-10-20T04:00:00.000Z'
export const releaseSha = 'a'.repeat(40)
export const issue = (id = '123', environment: string | null = 'production') => ({
  id,
  title: 'Request failed for user@example.com',
  firstSeen: start,
  lastSeen: end,
  project: { id: project.id, slug: project.slug },
  matchingEventEnvironment: environment,
  count: '9999',
  userCount: 0
})
export const incident: IncidentEvidence = {
  org: project.org,
  project: project.slug,
  issueId: '123',
  title: 'Request failed',
  url: `https://sentry.io/organizations/${project.org}/issues/123/`,
  firstSeen: start,
  lastSeen: end,
  environment: 'production',
  volume: {
    '15m': { events: null, affectedUsers: null },
    '1h': { events: null, affectedUsers: null },
    '24h': { events: null, affectedUsers: null },
    previous15m: { events: null, affectedUsers: null }
  }
}
export const event = (
  id: string,
  minutesAgo: number,
  user: string | null = null,
  environment = 'production'
) => ({
  eventID: id,
  groupID: '123',
  projectID: project.id,
  dateCreated: new Date(Date.parse(end) - minutesAgo * 60_000).toISOString(),
  tags: [{ key: 'environment', value: environment }],
  user: user ? { id: user, email: 'private@example.com' } : null
})
export const reply = (body: unknown, headers?: HeadersInit) =>
  new Response(JSON.stringify(body), { headers })
export const mockFetch = (
  handler: (url: URL, init?: RequestInit) => Response | Promise<Response>
) =>
  ((input: RequestInfo | URL, init?: RequestInit) =>
    Promise.resolve(handler(new URL(String(input)), init))) as typeof fetch
export const nextLink = (url: URL, cursor: string) => {
  const next = new URL(url)
  next.searchParams.set('cursor', cursor)
  return `<${next.href}>; rel="next"; results="true"; cursor="${cursor}"`
}
