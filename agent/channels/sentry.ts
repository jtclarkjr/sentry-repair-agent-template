import {
  defineChannel,
  GET,
  POST,
  SessionStrandedError,
  type ChannelResolveSession
} from 'eve/channels'
import { timingSafeEqual } from 'node:crypto'
import { repositories } from '../lib/registry'
import { monitoringEnabled, repositoryForWebhook, serviceAuth, verifySentrySignature, readBoundedBody, PayloadTooLargeError } from '../lib/incidents/intake'
import { hasUpdates } from '../lib/incidents/queue'

const ownerRecovery =
  'Inspect the recorded session and Workflow owner. Resume, cancel, or reset only after confirming no repair is running; preserve signed GitHub state and never steal a live repair lease.'
class RepairOwnerUnavailable extends Error {
  constructor(
    readonly details: {
      reason:
        | 'session-stranded'
        | 'owner-history-empty'
        | 'owner-check-timeout'
        | 'owner-unavailable'
      sessionId?: string
      lastEventType?: string
      lastEventAt?: string
      eveVersion?: string
    }
  ) {
    super('Repair owner is unavailable')
  }
}

export async function hasActiveRepair(
  resolveSession: ChannelResolveSession,
  address: string
) {
  const snapshot: {
    sessionId?: string
    lastEventType?: string
    lastEventAt?: string
  } = {}
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      (async () => {
        const session = await resolveSession(address)
        if (!session) return false
        snapshot.sessionId = session.id
        const reader = (
          await session.getEventStream({ startIndex: -1, follow: false })
        ).getReader()
        try {
          const { done, value } = await reader.read()
          if (done)
            throw new RepairOwnerUnavailable({
              reason: 'owner-history-empty',
              ...snapshot
            })
          snapshot.lastEventType = value.type
          snapshot.lastEventAt = value.meta?.at
          if (
            [
              'session.waiting',
              'session.completed',
              'session.failed',
              'turn.completed',
              'turn.failed',
              'turn.cancelled'
            ].includes(value.type)
          )
            return false
        } finally {
          await reader.cancel()
          reader.releaseLock()
        }
        // Public live-stream opening checks owner viability before returning.
        // Historical reads intentionally skip that check. No event is awaited,
        // no message is delivered, and cancellation only detaches this reader.
        try {
          const live = await session.getEventStream({
            startIndex: -1,
            follow: true
          })
          await live.cancel()
        } catch (error) {
          if (SessionStrandedError.is(error))
            throw new RepairOwnerUnavailable({
              reason: 'session-stranded',
              ...snapshot,
              ...(error.owner.eveVersion
                ? { eveVersion: error.owner.eveVersion }
                : {})
            })
          throw error
        }
        return true
      })(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () =>
            reject(
              new RepairOwnerUnavailable({
                reason: 'owner-check-timeout',
                ...snapshot
              })
            ),
          5_000
        )
      })
    ])
  } catch (error) {
    if (error instanceof RepairOwnerUnavailable) throw error
    throw new RepairOwnerUnavailable({
      reason: 'owner-unavailable',
      ...snapshot
    })
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

export default defineChannel({
  turnPolicy: 'queue',
  routes: [
    GET('/health', async () =>
      Response.json({ ok: true, monitoringEnabled: monitoringEnabled() })
    ),
    POST('/webhooks/sentry', async (request, { from, resolveSession }) => {
      if (Number(request.headers.get('content-length') ?? 0) > 64_000)
        return new Response('Payload too large', { status: 413 })
      let raw: string
      try {
        raw = await readBoundedBody(request, 64_000)
      } catch (error) {
        return new Response(
          error instanceof PayloadTooLargeError
            ? 'Payload too large'
            : 'Invalid body',
          { status: error instanceof PayloadTooLargeError ? 413 : 400 }
        )
      }
      if (
        !verifySentrySignature(
          raw,
          request.headers.get('sentry-hook-signature')
        )
      )
        return new Response('Invalid signature', { status: 401 })
      let payload: unknown
      try {
        payload = JSON.parse(raw)
      } catch {
        return new Response('Invalid payload', { status: 400 })
      }
      // Installation delivery must succeed while incident processing is deliberately disabled.
      if (request.headers.get('sentry-hook-resource') === 'installation')
        return Response.json({ accepted: true, resource: 'installation' })
      if (!monitoringEnabled())
        return Response.json(
          { accepted: false, reason: 'monitoring-disabled' },
          { status: 503 }
        )
      let repo
      try {
        repo = repositoryForWebhook(payload)
      } catch {
        return new Response('Invalid payload', { status: 400 })
      }
      if (!repo) return Response.json({ ignored: true })
      try {
        if (await hasActiveRepair(resolveSession, `repo:${repo.id}`))
          return Response.json({
            accepted: true,
            changed: false,
            reason: 'repair-active'
          })
      } catch (error) {
        if (!(error instanceof RepairOwnerUnavailable)) throw error
        return Response.json(
          {
            accepted: false,
            reason: 'repair-owner-unavailable',
            ownership: { ...error.details, recovery: ownerRecovery }
          },
          { status: 503 }
        )
      }
      if (!(await hasUpdates(repo)))
        return Response.json({ accepted: true, changed: false })
      await from(`repo:${repo.id}`).send(
        'Call repair-next once for the highest-priority pending incident in this authenticated repository.',
        { auth: serviceAuth(repo) }
      )
      return Response.json({ accepted: true }, { status: 202 })
    }),
    GET('/cron/reconcile', async (request, { from, resolveSession }) => {
      const expected = process.env.CRON_SECRET
      const supplied = request.headers.get('authorization')
      if (!expected || !supplied)
        return new Response('Unauthorized', { status: 401 })
      const left = Buffer.from(`Bearer ${expected}`)
      const right = Buffer.from(supplied)
      if (left.length !== right.length || !timingSafeEqual(left, right))
        return new Response('Unauthorized', { status: 401 })
      if (!monitoringEnabled())
        return Response.json({ skipped: 'monitoring-disabled' })
      let scheduled = 0
      const unavailable: string[] = []
      const ownership: {
        repositoryId: string
        reason: string
        sessionId?: string
        lastEventType?: string
        lastEventAt?: string
        eveVersion?: string
        recovery: string
      }[] = []
      for (const repo of repositories) {
        try {
          if (await hasActiveRepair(resolveSession, `repo:${repo.id}`)) continue
          if (!(await hasUpdates(repo))) continue
          await from(`repo:${repo.id}`).send(
            'Reconcile and process the highest-priority pending incident. Call repair-next once.',
            { auth: serviceAuth(repo) }
          )
          scheduled++
        } catch (error) {
          unavailable.push(repo.id)
          if (error instanceof RepairOwnerUnavailable)
            ownership.push({
              repositoryId: repo.id,
              ...error.details,
              recovery: ownerRecovery
            })
        }
      }
      return Response.json(
        { scheduled, unavailable, ...(ownership.length ? { ownership } : {}) },
        { status: unavailable.length ? 503 : 200 }
      )
    })
  ]
})
