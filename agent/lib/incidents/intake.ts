import { createHmac, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { repositories, type RepositoryConfig } from '../registry'

export const monitoringEnabled = () => process.env.MONITOR_ENABLED === 'true'
export class PayloadTooLargeError extends Error {
  readonly status = 413
  constructor() {
    super('Payload too large')
  }
}
export async function readBoundedBody(
  request: Request,
  maxBytes = 64_000
): Promise<string> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1)
    throw new RangeError('Invalid body limit')
  if (Number(request.headers.get('content-length') ?? 0) > maxBytes)
    throw new PayloadTooLargeError()
  if (!request.body) return ''
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > maxBytes) {
        void reader.cancel().catch(() => undefined)
        throw new PayloadTooLargeError()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    bytes
  )
}
export function verifySentrySignature(
  raw: string | Uint8Array,
  signature: string | null,
  secret = process.env.SENTRY_WEBHOOK_SECRET
) {
  if (!secret || !signature || !/^[a-f0-9]{64}$/i.test(signature)) return false
  const expected = createHmac('sha256', secret).update(raw).digest()
  return timingSafeEqual(expected, Buffer.from(signature, 'hex'))
}
export function repositoryForWebhook(
  value: unknown
): RepositoryConfig | undefined {
  const object = z.record(z.string(), z.unknown())
  const body = object.parse(value)
  const data = object.parse(body.data ?? {})
  const issue = object.parse(data.issue ?? {})
  const event = object.parse(data.event ?? {})
  const projects = [
    issue.project,
    event.project,
    data.project,
    body.project
  ].filter((project) => project !== undefined && project !== null)
  if (!projects.length) return undefined
  const matches = projects.map((project) => {
    const identity = typeof project === 'object' ? object.parse(project) : null
    const ids = identity
      ? [identity.id, identity.slug].filter(
          (id) => id !== undefined && id !== null
        )
      : [project]
    if (!ids.length) return undefined
    const matched = ids.map((id) => {
      if (typeof id === 'number' && (!Number.isSafeInteger(id) || id < 1))
        return undefined
      if (typeof id !== 'number' && typeof id !== 'string') return undefined
      return repositories.find((repo) =>
        repo.projects.some(
          (entry) => entry.id === String(id) || entry.slug === id
        )
      )
    })
    return matched[0] && matched.every((repo) => repo?.id === matched[0]!.id)
      ? matched[0]
      : undefined
  })
  const repo = matches[0]
  if (!repo || matches.some((match) => match?.id !== repo.id)) return undefined
  const organization = body.organization
  if (organization !== undefined) {
    const slug =
      typeof organization === 'string'
        ? organization
        : object.parse(organization).slug
    if (
      typeof slug !== 'string' ||
      !repo.projects.some((project) => project.org === slug)
    )
      return undefined
  }
  if (
    typeof event.environment === 'string' &&
    !repo.environments.includes(event.environment)
  )
    return undefined
  return repo
}
export function serviceAuth(repo: RepositoryConfig) {
  return {
    authenticator: 'verified-sentry',
    principalType: 'service' as const,
    principalId: 'incident-agent',
    attributes: { repositoryId: repo.id }
  }
}
export function authorizedRepository(auth: unknown) {
  const verified = z
    .object({
      authenticator: z.literal('verified-sentry'),
      principalType: z.literal('service'),
      principalId: z.literal('incident-agent'),
      attributes: z.object({ repositoryId: z.string() })
    })
    .safeParse(auth)
  const repo = verified.success
    ? repositories.find(
        (repo) => repo.id === verified.data.attributes.repositoryId
      )
    : undefined
  if (!repo) throw new Error('No verified repository scope in session')
  return repo
}
