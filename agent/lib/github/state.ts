import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { sanitizeText } from '../redaction'

export const markerSchema = z.object({
  version: z.literal(1),
  issueId: z.string(),
  project: z.string(),
  status: z.enum([
    'queued',
    'investigating',
    'reported',
    'verified',
    'pr-open',
    'budget-paused'
  ]),
  releaseKey: z.string(),
  lastSeen: z.string(),
  attempts: z.number().int().nonnegative(),
  priority: z.enum(['P0', 'P1', 'P2', 'P3']),
  assessment: z.unknown().optional(),
  flows: z.array(z.unknown()).optional(),
  rootCause: z.unknown().optional(),
  prUrl: z.string().optional(),
  repository: z.string().optional(),
  org: z.string().optional(),
  executionDeadline: z.string().datetime({ offset: true }).optional(),
  pausedUntil: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
  verification: z
    .object({
      status: z.string(),
      summary: z.string(),
      commands: z
        .array(
          z.object({
            command: z.string(),
            exitCode: z.number().int(),
            output: z.string()
          })
        )
        .optional(),
      regression: z
        .object({ before: z.number().int(), after: z.number().int() })
        .optional()
    })
    .optional()
})
export type IncidentMarker = z.infer<typeof markerSchema>

function sanitizeState(value: unknown, depth = 0): unknown {
  if (depth > 10)
    throw new Error('Incident state nesting exceeds the report marker limit')
  if (typeof value === 'string') return sanitizeText(value)
  if (Array.isArray(value))
    return value.map((item) => sanitizeState(item, depth + 1))
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sanitizeState(item, depth + 1)
      ])
    )
  return value
}

export function encodeMarker(marker: IncidentMarker) {
  const parsed = markerSchema.parse(marker)
  const clean = {
    ...parsed,
    rootCause: sanitizeState(parsed.rootCause),
    flows: sanitizeState(parsed.flows),
    assessment: sanitizeState(parsed.assessment),
    verification: sanitizeState(parsed.verification)
  }
  const value = Buffer.from(JSON.stringify(clean)).toString('base64url')
  if (value.length > 18_000)
    throw new Error('Incident state exceeds the report marker limit')
  return `<!-- sentry-repair-agent:${value}.${markerSignature(value)} -->`
}
export function markerSignature(value: string) {
  if (!process.env.STATE_SIGNING_SECRET)
    throw new Error(
      'STATE_SIGNING_SECRET is required to authenticate report state'
    )
  return createHmac('sha256', process.env.STATE_SIGNING_SECRET)
    .update(value)
    .digest('base64url')
}
export function decodeMarker(body: string): IncidentMarker | null {
  const match = body.match(
    /<!-- sentry-repair-agent:([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+) -->/
  )
  const value = match?.[1]
  if (!value || value.length > 60_000) return null
  try {
    const signature = Buffer.from(markerSignature(value))
    const received = Buffer.from(match![2])
    if (
      signature.length !== received.length ||
      !timingSafeEqual(signature, received)
    )
      return null
    return markerSchema.parse(
      JSON.parse(Buffer.from(value, 'base64url').toString())
    )
  } catch {
    return null
  }
}
