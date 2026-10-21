import { strict as assert } from 'node:assert'
import { createHmac } from 'node:crypto'
import { test } from 'node:test'
import { authorizedRepository, PayloadTooLargeError, readBoundedBody, repositoryForWebhook, serviceAuth, verifySentrySignature } from '../../incidents/intake'
import { repositories } from '../../registry'

const repo = repositories[0]
const other = { projects: [{ id: '9876543210', slug: 'unconfigured-project' }] }
const project = repo.projects[0]
function body(projectValue: unknown = project.id) {
  return {
    data: { event: { project: projectValue, environment: 'production' } }
  }
}

test('Sentry HMAC validates exact bytes and rejects missing, altered, or malformed signatures', () => {
  const raw = '{"message":"incident 日本語"}'
  const signature = createHmac('sha256', 'test-secret')
    .update(raw)
    .digest('hex')
  assert.equal(verifySentrySignature(raw, signature, 'test-secret'), true)
  assert.equal(
    verifySentrySignature(
      new TextEncoder().encode(raw),
      signature,
      'test-secret'
    ),
    true
  )
  assert.equal(
    verifySentrySignature(raw + ' ', signature, 'test-secret'),
    false
  )
  for (const invalid of [null, '', 'x'.repeat(64), signature.slice(1)])
    assert.equal(verifySentrySignature(raw, invalid, 'test-secret'), false)
  assert.equal(verifySentrySignature(raw, signature, ''), false)
})

test('project mapping accepts canonical IDs/slugs and ignores display names', () => {
  for (const identity of [
    project.id,
    Number(project.id),
    project.slug,
    { id: project.id, slug: project.slug }
  ])
    assert.equal(repositoryForWebhook(body(identity))?.id, repo.id)
  assert.equal(
    repositoryForWebhook(body({ id: 'unknown', name: project.slug })),
    undefined
  )
  assert.equal(repositoryForWebhook(body({ name: project.slug })), undefined)
  assert.equal(
    repositoryForWebhook(
      body({ id: project.id, slug: other.projects[0].slug })
    ),
    undefined
  )
  assert.equal(
    repositoryForWebhook({ project: other.projects[0].id, ...body() }),
    undefined
  )
  assert.equal(
    repositoryForWebhook({ organization: 'different-org', ...body() }),
    undefined
  )
  assert.equal(
    repositoryForWebhook({
      data: { event: { project: project.id, environment: 'preview' } }
    }),
    undefined
  )
})

test('repository scope requires the complete verified service principal', () => {
  assert.equal(authorizedRepository(serviceAuth(repo)).id, repo.id)
  for (const auth of [
    undefined,
    serviceAuth(repo).attributes,
    { ...serviceAuth(repo), authenticator: 'unverified' },
    { ...serviceAuth(repo), principalType: 'user' },
    { ...serviceAuth(repo), principalId: 'different-service' },
    { ...serviceAuth(repo), attributes: { repositoryId: 'unknown' } }
  ])
    assert.throws(() => authorizedRepository(auth))
})

test('body reader preserves valid UTF-8 bytes at the exact size limit', async () => {
  const text = '{"value":"日本語"}'
  const bytes = new TextEncoder().encode(text)
  const request = new Request('https://agent.invalid/webhook', {
    method: 'POST',
    body: bytes
  })
  assert.equal(await readBoundedBody(request, bytes.byteLength), text)
  const invalid = new Request('https://agent.invalid/webhook', {
    method: 'POST',
    body: new Uint8Array([0xff])
  })
  await assert.rejects(readBoundedBody(invalid), TypeError)
})

test('body reader rejects dishonest or absent Content-Length without buffering the full stream', async () => {
  let cancelled = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(5))
      controller.enqueue(new Uint8Array(5))
    },
    cancel() {
      cancelled = true
    }
  })
  const request = new Request('https://agent.invalid/webhook', {
    method: 'POST',
    headers: { 'content-length': '1' },
    body: stream,
    duplex: 'half'
  } as RequestInit)
  await assert.rejects(readBoundedBody(request, 8), PayloadTooLargeError)
  assert.equal(cancelled, true)
  await assert.rejects(
    readBoundedBody(
      new Request('https://agent.invalid/webhook', {
        method: 'POST',
        headers: { 'content-length': '99' },
        body: 'small'
      }),
      8
    ),
    PayloadTooLargeError
  )
})
