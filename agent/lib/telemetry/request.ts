export type ReadOptions = {
  fetch?: typeof fetch
  token?: string
  deadline?: number
}

export function apiError(service: string, error: unknown) {
  return error instanceof Error && error.message.startsWith(`${service}:`)
    ? error.message
    : `${service}: request failed or response was invalid`
}

export async function request(
  url: URL,
  token: string,
  service: string,
  options: ReadOptions,
  signal?: AbortSignal
) {
  const remaining =
    options.deadline === undefined ? 15_000 : options.deadline - Date.now()
  if (remaining <= 0)
    throw new Error(`${service}: reconciliation deadline reached`)
  const response = await (options.fetch ?? fetch)(url, {
    method: 'GET',
    credentials: 'omit',
    redirect: 'error',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: signal ?? AbortSignal.timeout(Math.min(15_000, remaining))
  })
  if (!response.ok) {
    await response.body?.cancel()
    throw new Error(`${service}: HTTP ${response.status}`)
  }
  return response
}

export async function json(response: Response) {
  const reader = response.body?.getReader()
  if (!reader) throw new Error('Missing response body')
  let source = ''
  let size = 0
  const decoder = new TextDecoder()
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > 2_000_000) throw new Error('Response too large')
      source += decoder.decode(value, { stream: true })
    }
    return JSON.parse(source + decoder.decode()) as unknown
  } finally {
    await reader.cancel()
  }
}

export function windowBounds(start: string | undefined, end: string | undefined) {
  const until = new Date(end ?? Date.now())
  const from = new Date(start ?? until.getTime() - 86_400_000)
  if (
    !Number.isFinite(from.getTime()) ||
    !Number.isFinite(until.getTime()) ||
    from >= until
  )
    throw new Error('Sentry: invalid time window')
  return { start: from.toISOString(), end: until.toISOString() }
}
