import { z } from 'zod'
import type { CountWindow } from '../incidents/model'
import type { RepositoryConfig } from '../registry'
import { redactTelemetryText } from '../redaction'

const text = z.string().nullable().optional()
const tagsSchema = z
  .array(z.object({ key: z.string(), value: z.string() }))
  .optional()
export const eventSchema = z
  .object({
    eventID: z.string().optional(),
    id: z.string().optional(),
    groupID: z.string().optional(),
    projectID: z.union([z.string(), z.number()]).optional(),
    dateCreated: z.string().datetime({ offset: true }),
    environment: text,
    tags: tagsSchema,
    user: z
      .object({ id: z.union([z.string(), z.number()]).nullable().optional() })
      .nullable()
      .optional(),
    entries: z
      .array(z.object({ type: z.string(), data: z.unknown() }))
      .optional(),
    contexts: z.record(z.string(), z.unknown()).optional(),
    release: z.unknown().optional()
  })
  .refine(
    (event) => Boolean(event.eventID || event.id),
    'Event identifier missing'
  )

export const emptyCount = (): CountWindow => ({ events: null, affectedUsers: null })
export const emptyVolume = () => ({
  '15m': emptyCount(),
  '1h': emptyCount(),
  '24h': emptyCount(),
  previous15m: emptyCount()
})
export const object = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const field = (value: unknown): string | null =>
  typeof value === 'string' ? value : null
const integer = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null
const sha = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-f\d]{40}$/i.test(value)
    ? value.toLowerCase()
    : undefined

export function sentryUrl(org: string, path: string, repository: RepositoryConfig) {
  const url = new URL(
    `https://sentry.io/api/0/organizations/${encodeURIComponent(org)}/${path}`
  )
  for (const environment of repository.environments)
    url.searchParams.append('environment', environment)
  return url
}

export function nextCursor(response: Response, requestUrl: URL) {
  const next = response.headers
    .get('link')
    ?.split(',')
    .find((part) => /rel="next"/.test(part) && /results="true"/.test(part))
  if (!next) return null
  const target = next.match(/<([^>]+)>/)?.[1]
  if (!target) throw new Error('Sentry: invalid pagination link')
  const url = new URL(target)
  if (url.origin !== requestUrl.origin || url.pathname !== requestUrl.pathname)
    throw new Error('Sentry: invalid pagination target')
  const cursor = url.searchParams.get('cursor')
  if (!cursor || cursor.length > 300)
    throw new Error('Sentry: invalid pagination cursor')
  return cursor
}

export function eventEnvironment(event: z.infer<typeof eventSchema>) {
  return (
    event.environment ??
    event.tags?.find((tag) => tag.key === 'environment')?.value ??
    null
  )
}

function releaseDetails(value: unknown, repository: RepositoryConfig) {
  const release = object(value)
  const lastCommit = object(release.lastCommit)
  const releaseRepository = object(lastCommit.repository)
  const sameRepo =
    releaseRepository.externalSlug ===
      `${repository.owner}/${repository.repo}` ||
    releaseRepository.name === `${repository.owner}/${repository.repo}`
  const version = typeof value === 'string' ? value : field(release.version)
  return {
    version: version ? redactTelemetryText(version) : null,
    sha: sha(version) ?? (sameRepo ? sha(lastCommit.id) : undefined)
  }
}

export function safeEventDetails(
  event: z.infer<typeof eventSchema>,
  repository: RepositoryConfig,
  token: string
) {
  const clean = (value: unknown) =>
    typeof value === 'string' ? redactTelemetryText(value, [token]) : null
  const entries = event.entries ?? []
  const exceptions = entries
    .filter((entry) => entry.type === 'exception')
    .flatMap((entry) => list(object(entry.data).values))
    .slice(-5)
    .map((value) => {
      const exception = object(value)
      return {
        type: clean(exception.type),
        message: clean(exception.value),
        frames: list(object(exception.stacktrace).frames)
          .slice(-30)
          .map((frameValue) => {
            const frame = object(frameValue)
            return {
              file: clean(frame.filename),
              function: clean(frame.function),
              line: integer(frame.lineNo),
              column: integer(frame.colNo),
              inApp: frame.inApp === true
            }
          })
      }
    })
  const breadcrumbs = entries
    .filter((entry) => entry.type === 'breadcrumbs')
    .flatMap((entry) => list(object(entry.data).values))
    .slice(-20)
    .map((value) => {
      const crumb = object(value)
      const data = object(crumb.data)
      return {
        category: clean(crumb.category),
        level: clean(crumb.level),
        timestamp: clean(crumb.timestamp),
        message: clean(crumb.message),
        method: clean(data.method),
        url: clean(data.url),
        status: integer(data.status_code)
      }
    })
  const trace = object(event.contexts?.trace)
  return {
    eventId: event.eventID ?? event.id!,
    timestamp: event.dateCreated,
    environment: eventEnvironment(event),
    exceptions,
    breadcrumbs,
    trace: {
      traceId:
        typeof trace.trace_id === 'string' &&
        /^[a-f\d]{32}$/i.test(trace.trace_id)
          ? trace.trace_id
          : null,
      spanId:
        typeof trace.span_id === 'string' &&
        /^[a-f\d]{16}$/i.test(trace.span_id)
          ? trace.span_id
          : null,
      operation: clean(trace.op)
    },
    release: releaseDetails(
      event.release ?? event.tags?.find((tag) => tag.key === 'release')?.value,
      repository
    )
  }
}
