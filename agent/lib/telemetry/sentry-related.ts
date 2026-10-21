import { z } from 'zod'
import type { RepositoryConfig } from '../registry'
import { redactTelemetryText } from '../redaction'
import { apiError, json, request, windowBounds, type ReadOptions } from './request'
import { nextCursor, object, sentryUrl } from './sentry-api'

/** Explore rows are bounded samples, never incident counts or proof of missing telemetry. */
export async function collectRelatedSentryTelemetry(
  repository: RepositoryConfig,
  traceId: string | undefined,
  options: ReadOptions & { start: string; end: string; project?: string }
) {
  const bounds = windowBounds(options.start, options.end)
  const project = options.project
    ? repository.projects.find(
        (entry) =>
          entry.slug === options.project || entry.id === options.project
      )
    : repository.projects.length === 1
      ? repository.projects[0]
      : undefined
  const token = options.token ?? process.env.SENTRY_AUTH_TOKEN
  const errors: string[] = []
  const validTrace =
    typeof traceId === 'string' && /^[a-f\d]{32}$/i.test(traceId)
      ? traceId.toLowerCase()
      : null
  const limitations = [
    'At most 50 rows per dataset are sampled; sampling, instrumentation, retention and pagination coverage remain unknown. Empty samples do not establish that no spans or logs exist.'
  ]
  if (!traceId)
    limitations.push(
      'No event trace ID is available. Time-window matches are contextual evidence only; correlation with this incident is unknown.'
    )
  const sample = () => ({
    status: 'unavailable' as 'unavailable' | 'observed' | 'not-observed',
    rows: [] as Array<{
      id: string | null
      timestamp: string
      environment: string
      traceId: string | null
      parentSpanId?: string | null
      operation?: string | null
      description?: string | null
      status?: string | null
      durationMs?: number | null
      severity?: string | null
      message?: string | null
    }>,
    totalRows: null,
    complete: false as const,
    limitReached: false
  })
  const result = {
    scope: {
      org: project?.org ?? null,
      project: project?.slug ?? null,
      environments: [...repository.environments],
      ...bounds,
      traceId: validTrace
    },
    correlation: validTrace ? 'trace' : 'time-window-only',
    spans: sample(),
    logs: sample(),
    errors,
    limitations
  }
  if (
    !project ||
    !repository.environments.length ||
    (traceId !== undefined && !validTrace) ||
    Date.parse(bounds.end) - Date.parse(bounds.start) > 3_600_000
  ) {
    errors.push(
      'Sentry: invalid related-telemetry scope, trace ID or window (maximum one hour)'
    )
    return result
  }
  if (!token) {
    errors.push(
      'Sentry: SENTRY_AUTH_TOKEN missing; related spans and logs unavailable'
    )
    return result
  }
  const clean = (value: unknown) =>
    typeof value === 'string' ? redactTelemetryText(value, [token]) : null
  const hex = (value: unknown, length: number) =>
    typeof value === 'string' &&
    new RegExp(`^[a-f\\d]{${length}}$`, 'i').test(value)
      ? value.toLowerCase()
      : null
  // https://docs.sentry.io/api/explore/query-explore-events-in-table-format/
  // Keep project and environment filters even when the same trace crosses other services.
  for (const dataset of ['spans', 'logs'] as const) {
    const target = result[dataset]
    try {
      const url = sentryUrl(project.org, 'events/', repository)
      url.searchParams.set('dataset', dataset)
      url.searchParams.set('project', project.id)
      url.searchParams.set('start', bounds.start)
      url.searchParams.set('end', bounds.end)
      url.searchParams.set('per_page', '50')
      url.searchParams.set('sort', '-timestamp')
      if (validTrace) url.searchParams.set('query', `trace:${validTrace}`)
      const fields = [
        'id',
        'project.id',
        'environment',
        'trace',
        'timestamp',
        ...(dataset === 'spans'
          ? [
              'parent_span',
              'span.op',
              'span.description',
              'span.status',
              'span.duration'
            ]
          : ['severity', 'message'])
      ]
      for (const name of fields) url.searchParams.append('field', name)
      const response = await request(url, token, 'Sentry', options)
      const payload = z
        .object({ data: z.array(z.unknown()) })
        .parse(await json(response))
      target.limitReached =
        payload.data.length >= 50 || nextCursor(response, url) !== null
      let discarded = false
      for (const entry of payload.data.slice(0, 50)) {
        const row = object(entry)
        const timestamp =
          typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN
        const rowTrace = hex(row.trace, 32)
        if (
          String(row['project.id']) !== project.id ||
          typeof row.environment !== 'string' ||
          !repository.environments.includes(row.environment) ||
          !Number.isFinite(timestamp) ||
          timestamp < Date.parse(bounds.start) ||
          timestamp >= Date.parse(bounds.end) ||
          (validTrace && rowTrace !== validTrace)
        ) {
          discarded = true
          continue
        }
        target.rows.push({
          id: clean(row.id),
          timestamp: new Date(timestamp).toISOString(),
          environment: row.environment,
          traceId: rowTrace,
          ...(dataset === 'spans'
            ? {
                parentSpanId: hex(row.parent_span, 16),
                operation: clean(row['span.op']),
                description: clean(row['span.description']),
                status: clean(row['span.status']),
                durationMs:
                  typeof row['span.duration'] === 'number' &&
                  Number.isFinite(row['span.duration']) &&
                  row['span.duration'] >= 0
                    ? row['span.duration']
                    : null
              }
            : { severity: clean(row.severity), message: clean(row.message) })
        })
      }
      if (discarded)
        limitations.push(
          `Sentry: ${dataset} rows with missing or mismatched scope were discarded`
        )
      target.status = target.rows.length ? 'observed' : 'not-observed'
    } catch (error) {
      errors.push(
        `${apiError('Sentry', error)}; related ${dataset} unavailable`
      )
    }
  }
  return result
}
