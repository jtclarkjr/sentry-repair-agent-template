export function sanitizeText(value: string, maxLength = 12_000): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(
      /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g,
      ''
    )
    .replace(
      /-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g,
      '[REDACTED PRIVATE KEY]'
    )
    .replace(
      /\b(?:Bearer|Basic)\s+[A-Za-z\d+/_=.~\-]+/gi,
      '[REDACTED AUTHORIZATION]'
    )
    .replace(
      /\b(?:gh[pousr]_|github_pat_|glpat-|sk-|sntrys_|xox[baprs]-|vck_)[A-Za-z\d_\-]{8,}/g,
      '[REDACTED TOKEN]'
    )
    .replace(
      /\beyJ[A-Za-z\d_\-]+\.[A-Za-z\d_\-]+\.[A-Za-z\d_\-]+\b/g,
      '[REDACTED JWT]'
    )
    .replace(/((?:set-)?cookie["']?\s*[:=]\s*)[^\r\n]+/gi, '$1[REDACTED]')
    .replace(
      /(["']?(?:[\w-]*(?:token|secret|password|passwd|api[_-]?key)|authorization|cookie|set-cookie|database_url)["']?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}]+)/gi,
      '$1[REDACTED]'
    )
    .replace(/https?:\/\/[^\s<>]+/gi, (match) => {
      try {
        const url = new URL(match)
        url.username = ''
        url.password = ''
        for (const key of url.searchParams.keys())
          url.searchParams.set(key, '[REDACTED]')
        url.hash = ''
        return url.toString()
      } catch {
        return '[REDACTED URL]'
      }
    })
    .replace(
      /\b[A-Z\d.!#$%&'*+/=?^_`{|}~\-]+@[A-Z\d.\-]+\.[A-Z]{2,}\b/gi,
      '[REDACTED EMAIL]'
    )
    .replace(/@(?!\u200b)/g, '@\u200b')
    .slice(0, maxLength)
}

export function redactTelemetryText(
  value: string,
  secrets: string[] = []
): string {
  let result = value
  for (const secret of [
    ...secrets,
    process.env.SENTRY_AUTH_TOKEN,
    process.env.VERCEL_READ_TOKEN
  ]) {
    if (secret) result = result.split(secret).join('[redacted]')
  }
  return result
    .replace(/https?:\/\/[^\s<>"']+/gi, (raw) => {
      try {
        const url = new URL(raw)
        url.username = ''
        url.password = ''
        url.search = ''
        url.hash = ''
        return url.toString()
      } catch {
        return '[url]'
      }
    })
    .replace(/\bBearer\s+[^\s,;"']+/gi, 'Bearer [redacted]')
    .replace(/((?:\/[\w@%.,~:+-]+)+)\?[^\s"'<>]*/g, '$1')
    .replace(
      /["']?\b(?:authorization|cookie|set-cookie|password|secret|api[_-]?key|access[_-]?token|refresh[_-]?token)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,
      '[credential redacted]'
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
      '[token]'
    )
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[email]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
    .replace(/\b(?:[\da-f]{1,4}:){2,}[\da-f:]{1,39}\b/gi, '[ip]')
    .slice(0, 800)
}
