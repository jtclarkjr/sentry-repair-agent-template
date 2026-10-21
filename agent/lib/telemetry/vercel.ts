import { z } from 'zod'
import type { RepositoryConfig } from '../registry'
import { redactTelemetryText } from '../redaction'
import { apiError, json, request, windowBounds, type ReadOptions } from './request'

const text = z.string().nullable().optional()
const sha = (value: unknown): string | undefined =>
  typeof value === 'string' && /^[a-f\d]{40}$/i.test(value)
    ? value.toLowerCase()
    : undefined

const deploymentSchema = z.object({
  uid: z.string(),
  projectId: z.string(),
  target: z.string().nullable(),
  created: z.number(),
  url: z.string().nullable(),
  state: text,
  meta: z.record(z.string(), z.unknown()).optional()
})
const runtimeLogSchema = z.object({
  rowId: z.string(),
  timestampInMs: z.number(),
  level: z.string(),
  source: z.string(),
  message: z.string(),
  requestPath: z.string(),
  requestMethod: z.string(),
  responseStatusCode: z.number(),
  messageTruncated: z.boolean()
})

export async function collectVercelEvidence(
  repository: RepositoryConfig,
  options: ReadOptions & { start: string; end: string; releaseSha?: string }
) {
  const deployments: Array<{
    id: string
    created: number
    url: string | null
    state: string | null
    sha: string | null
  }> = []
  const logs: Array<{
    id: string
    timestamp: number
    level: string
    message: string
    path: string
    status: number
  }> = []
  const errors: string[] = []
  const result = {
    deployments,
    logs,
    errors,
    logsCoverage: 'bounded-live-sample' as const,
    historicalLogsComplete: false
  }
  const token = options.token ?? process.env.VERCEL_READ_TOKEN
  if (!token)
    return {
      ...result,
      errors: [
        'Vercel: VERCEL_READ_TOKEN missing; deployment metadata and runtime logs unavailable'
      ]
    }
  const bounds = windowBounds(options.start, options.end)
  try {
    const url = new URL('https://api.vercel.com/v7/deployments')
    url.searchParams.set('projectId', repository.vercelProjectId)
    url.searchParams.set('teamId', repository.vercelTeamId)
    url.searchParams.set('target', 'production')
    url.searchParams.set('limit', '5')
    url.searchParams.set('until', String(Date.parse(bounds.end)))
    if (options.releaseSha) url.searchParams.set('sha', options.releaseSha)
    const response = z
      .object({ deployments: z.array(deploymentSchema) })
      .parse(await json(await request(url, token, 'Vercel', options)))
    for (const deployment of response.deployments) {
      if (
        deployment.projectId !== repository.vercelProjectId ||
        deployment.target !== 'production'
      )
        continue
      deployments.push({
        id: deployment.uid,
        created: deployment.created,
        url: deployment.url
          ? redactTelemetryText(deployment.url, [token])
          : null,
        state: deployment.state ?? null,
        sha: sha(deployment.meta?.githubCommitSha) ?? null
      })
    }
  } catch (error) {
    errors.push(apiError('Vercel', error))
    return result
  }
  const deployment = deployments[0]
  if (!deployment) {
    errors.push(
      'Vercel: no matching production deployment; runtime logs unavailable'
    )
    return result
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 3_000)
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  try {
    const url = new URL(
      `https://api.vercel.com/v1/projects/${encodeURIComponent(repository.vercelProjectId)}/deployments/${encodeURIComponent(deployment.id)}/runtime-logs`
    )
    url.searchParams.set('teamId', repository.vercelTeamId)
    const response = await request(
      url,
      token,
      'Vercel',
      options,
      controller.signal
    )
    reader = response.body?.getReader()
    if (!reader) throw new Error('Vercel: runtime log response missing')
    let buffer = ''
    let size = 0
    const decoder = new TextDecoder()
    const seen = new Set<string>()
    const accept = (line: string) => {
      if (!line.trim()) return
      const log = runtimeLogSchema.parse(JSON.parse(line))
      if (
        seen.has(log.rowId) ||
        log.timestampInMs < Date.parse(bounds.start) ||
        log.timestampInMs >= Date.parse(bounds.end)
      )
        return
      seen.add(log.rowId)
      logs.push({
        id: log.rowId,
        timestamp: log.timestampInMs,
        level: redactTelemetryText(log.level),
        message: redactTelemetryText(log.message, [token]),
        path: redactTelemetryText(log.requestPath.split(/[?#]/, 1)[0], [token]),
        status: log.responseStatusCode
      })
    }
    while (logs.length < 50) {
      const { done, value } = await reader.read()
      if (done) {
        if (buffer.trim()) accept(buffer)
        break
      }
      size += value.byteLength
      if (size > 256_000) {
        errors.push('Vercel: runtime log sample reached byte limit')
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (logs.length >= 50) break
        accept(line)
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) errors.push(apiError('Vercel', error))
  } finally {
    clearTimeout(timer)
    controller.abort()
    await reader?.cancel().catch(() => {})
  }
  errors.push(
    'Vercel: runtime API provides a bounded live stream, not complete incident-window history'
  )
  return result
}
