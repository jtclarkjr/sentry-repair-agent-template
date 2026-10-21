import { z } from 'zod'
import type { CountWindow, IncidentEvidence } from '../incidents/model'
import type { RepositoryConfig } from '../registry'
import { redactTelemetryText } from '../redaction'
import { apiError, json, request, windowBounds, type ReadOptions } from './request'
import {
  emptyCount,
  emptyVolume,
  eventEnvironment,
  eventSchema,
  nextCursor,
  safeEventDetails,
  sentryUrl
} from './sentry-api'

const text = z.string().nullable().optional()
const issueSchema = z.object({
  id: z.string().regex(/^\d+$/),
  title: z.string(),
  firstSeen: z.string().datetime({ offset: true }),
  lastSeen: z.string().datetime({ offset: true }),
  project: z.object({ id: z.string(), slug: z.string() }),
  matchingEventEnvironment: text
})
/** GET-only polling; persist both the cursor and its fixed start/end window together. */
export async function pollSentryIssues(
  repository: RepositoryConfig,
  options: ReadOptions & {
    start?: string
    end?: string
    cursor?: string
    project?: string
  } = {}
) {
  const incidents: IncidentEvidence[] = []
  const errors: string[] = []
  let cursor: string | null = options.cursor ?? null
  const bounds = windowBounds(options.start, options.end)
  const token = options.token ?? process.env.SENTRY_AUTH_TOKEN
  if (!token)
    return {
      incidents,
      nextCursor: cursor,
      complete: false,
      errors: ['Sentry: SENTRY_AUTH_TOKEN missing'],
      ...bounds
    }
  const project = options.project
    ? repository.projects.find(
        (entry) =>
          entry.slug === options.project || entry.id === options.project
      )
    : repository.projects.length === 1
      ? repository.projects[0]
      : undefined
  if (!project || !repository.environments.length)
    return {
      incidents,
      nextCursor: cursor,
      complete: false,
      errors: ['Sentry: project or environments not configured'],
      ...bounds
    }
  const seen = new Set<string>()
  const visited = new Set<string>()
  try {
    for (let page = 0; page < 4; page++) {
      const url = sentryUrl(project.org, 'issues/', repository)
      url.searchParams.set('project', project.id)
      url.searchParams.set('query', 'is:unresolved issue.category:error')
      url.searchParams.set('start', bounds.start)
      url.searchParams.set('end', bounds.end)
      url.searchParams.set('sort', 'date')
      url.searchParams.set('limit', '25')
      if (cursor) url.searchParams.set('cursor', cursor)
      const response = await request(url, token, 'Sentry', options)
      const issues = z.array(issueSchema).parse(await json(response))
      for (const issue of issues) {
        if (issue.project.id !== project.id || seen.has(issue.id)) continue
        const environment = issue.matchingEventEnvironment ?? null
        if (
          environment !== null &&
          !repository.environments.includes(environment)
        )
          continue
        seen.add(issue.id)
        incidents.push({
          org: project.org,
          project: project.slug,
          issueId: issue.id,
          title: redactTelemetryText(issue.title, [token]),
          url: `https://sentry.io/organizations/${encodeURIComponent(project.org)}/issues/${issue.id}/`,
          firstSeen: new Date(issue.firstSeen).toISOString(),
          lastSeen: new Date(issue.lastSeen).toISOString(),
          environment,
          volume: emptyVolume()
        })
      }
      const next = nextCursor(response, url)
      if (!next)
        return {
          incidents,
          nextCursor: null,
          complete: true,
          errors,
          ...bounds
        }
      if (next === cursor || visited.has(next))
        throw new Error('Sentry: repeated pagination cursor')
      visited.add(next)
      cursor = next
    }
  } catch (error) {
    errors.push(apiError('Sentry', error))
  }
  return { incidents, nextCursor: cursor, complete: false, errors, ...bounds }
}

async function aggregateWindows(
  repository: RepositoryConfig,
  incident: IncidentEvidence,
  end: number,
  token: string,
  options: ReadOptions
) {
  const project = repository.projects.find(
    (entry) => entry.org === incident.org && entry.slug === incident.project
  )!
  const volume = emptyVolume()
  const errors: string[] = []
  const windows = {
    '15m': [end - 900_000, end],
    '1h': [end - 3_600_000, end],
    '24h': [end - 86_400_000, end],
    previous15m: [end - 1_800_000, end - 900_000]
  } as const
  for (const [key, [from, until]] of Object.entries(windows)) {
    try {
      // https://docs.sentry.io/api/explore/query-explore-events-in-table-format/
      const url = sentryUrl(incident.org, 'events/', repository)
      url.searchParams.set('dataset', 'errors')
      url.searchParams.set('project', project.id)
      url.searchParams.append('field', 'count()')
      url.searchParams.append('field', 'count_unique(user)')
      url.searchParams.set('query', `issue.id:${incident.issueId}`)
      url.searchParams.set('start', new Date(from).toISOString())
      url.searchParams.set('end', new Date(until).toISOString())
      const response = z
        .object({
          data: z
            .array(
              z.object({
                'count()': z.number().int().nonnegative(),
                'count_unique(user)': z.number().int().nonnegative()
              })
            )
            .length(1)
        })
        .parse(await json(await request(url, token, 'Sentry', options)))
      const row = response.data[0]!
      volume[key as keyof typeof volume] = {
        events: row['count()'],
        affectedUsers:
          row['count_unique(user)'] > 0 ? row['count_unique(user)'] : null
      }
    } catch (error) {
      errors.push(`${apiError('Sentry', error)}; ${key} aggregate unavailable`)
    }
  }
  return { volume, errors }
}

export async function inspectSentryIssue(
  repository: RepositoryConfig,
  incident: IncidentEvidence,
  options: ReadOptions & { end?: string } = {}
) {
  const errors: string[] = []
  const unknown = {
    incident: {
      ...incident,
      volume: emptyVolume(),
      volumeObservedAt: undefined
    },
    details: null,
    errors
  }
  const token = options.token ?? process.env.SENTRY_AUTH_TOKEN
  if (!token)
    return { ...unknown, errors: ['Sentry: SENTRY_AUTH_TOKEN missing'] }
  const project = repository.projects.find(
    (entry) => entry.org === incident.org && entry.slug === incident.project
  )
  if (!project || !/^\d+$/.test(incident.issueId))
    return {
      ...unknown,
      errors: ['Sentry: incident outside configured project']
    }
  const bounds = windowBounds(undefined, options.end)
  const events = new Map<string, z.infer<typeof eventSchema>>()
  let cursor: string | null = null
  let complete = false
  let unscopedEvent = false
  const visited = new Set<string>()
  try {
    // shortcut: enumerate at most 500 events; use server aggregates when incident volume warrants it.
    for (let page = 0; page < 5; page++) {
      const url = sentryUrl(
        incident.org,
        `issues/${incident.issueId}/events/`,
        repository
      )
      url.searchParams.set('start', bounds.start)
      url.searchParams.set('end', bounds.end)
      url.searchParams.set('per_page', '100')
      if (cursor) url.searchParams.set('cursor', cursor)
      const response = await request(url, token, 'Sentry', options)
      const rows = z.array(eventSchema).parse(await json(response))
      for (const event of rows) {
        if (event.groupID && event.groupID !== incident.issueId) continue
        if (
          event.projectID !== undefined &&
          String(event.projectID) !== project.id
        )
          continue
        const environment = eventEnvironment(event)
        if (!environment) {
          unscopedEvent = true
          continue
        }
        if (!repository.environments.includes(environment)) continue
        const timestamp = Date.parse(event.dateCreated)
        if (
          timestamp < Date.parse(bounds.start) ||
          timestamp >= Date.parse(bounds.end)
        )
          continue
        events.set(event.eventID ?? event.id!, event)
      }
      const next = nextCursor(response, url)
      if (!next) {
        complete = !unscopedEvent
        break
      }
      if (visited.has(next) || next === cursor)
        throw new Error('Sentry: repeated pagination cursor')
      visited.add(next)
      cursor = next
    }
    if (!complete)
      errors.push(
        'Sentry: event pagination incomplete or environment unknown; server aggregates required'
      )
  } catch (error) {
    errors.push(apiError('Sentry', error))
  }
  const end = Date.parse(bounds.end)
  const count = (from: number, to: number): CountWindow => {
    if (!complete) return emptyCount()
    const rows = [...events.values()].filter(
      (event) =>
        Date.parse(event.dateCreated) >= from &&
        Date.parse(event.dateCreated) < to
    )
    const users = rows
      .map((event) => event.user?.id)
      .filter((id) => id !== undefined && id !== null && String(id).length > 0)
    return {
      events: rows.length,
      affectedUsers:
        rows.length > 0 && users.length === rows.length
          ? new Set(users.map(String)).size
          : null
    }
  }
  let volume = {
    '15m': count(end - 900_000, end),
    '1h': count(end - 3_600_000, end),
    '24h': count(end - 86_400_000, end),
    previous15m: count(end - 1_800_000, end - 900_000)
  }
  if (!complete && !errors.some((error) => /HTTP (401|403)/.test(error))) {
    const aggregate = await aggregateWindows(
      repository,
      incident,
      end,
      token,
      options
    )
    volume = aggregate.volume
    errors.push(...aggregate.errors)
  }
  let details: ReturnType<typeof safeEventDetails> | null = null
  try {
    const url = sentryUrl(
      incident.org,
      `issues/${incident.issueId}/events/latest/`,
      repository
    )
    const event = eventSchema.parse(
      await json(await request(url, token, 'Sentry', options))
    )
    if (
      !repository.environments.includes(eventEnvironment(event) ?? '') ||
      (event.projectID !== undefined &&
        String(event.projectID) !== project.id) ||
      (event.groupID && event.groupID !== incident.issueId)
    )
      throw new Error(
        'Sentry: latest event outside configured production project'
      )
    details = safeEventDetails(event, repository, token)
  } catch (error) {
    errors.push(apiError('Sentry', error))
  }
  return {
    incident: {
      ...incident,
      volume,
      volumeObservedAt: bounds.end,
      environment: details?.environment ?? incident.environment,
      releaseSha: details?.release.sha ?? incident.releaseSha
    },
    details,
    errors
  }
}
