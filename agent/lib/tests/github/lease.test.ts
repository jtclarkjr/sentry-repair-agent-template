import { test } from 'node:test'
import assert from 'node:assert/strict'
import { acquireLease, releaseLease } from '../../github/lease'
import { repository, baseSha, marker, leaseServer } from '../fixtures/github'

test('repository lease uses one lightweight tag, resumes its owner, and refuses competing owners', async () => {
  process.env.STATE_SIGNING_SECRET ??= 'synthetic-marker-signing-key'
  const { state, client } = leaseServer()
  assert.equal(
    await acquireLease(client, repository, 'workflow-call-1', baseSha),
    true
  )
  assert.equal(
    await acquireLease(client, repository, 'workflow-call-1', baseSha),
    true
  )
  assert.equal(
    await acquireLease(client, repository, 'workflow-call-2', baseSha),
    false
  )
  assert.equal(state.createdRefs, 1)
  assert.equal(state.createdCommits, 1)
  assert.equal(await releaseLease(client, repository, 'workflow-call-2'), false)
  assert.equal(state.deletedRefs, 0)
  assert.equal(await releaseLease(client, repository, 'workflow-call-1'), true)
  assert.equal(await releaseLease(client, repository, 'workflow-call-1'), true)
  assert.equal(state.deletedRefs, 1)
})

test('ambiguous lease creation reconciles the signed owner without replacing the lock', async () => {
  process.env.STATE_SIGNING_SECRET ??= 'synthetic-marker-signing-key'
  const { state, client } = leaseServer()
  state.loseRefResponse = true
  assert.equal(
    await acquireLease(client, repository, 'workflow-call-1', baseSha),
    true
  )
  assert.equal(state.createdRefs, 1)
  assert.equal(
    await acquireLease(client, repository, 'workflow-call-2', baseSha),
    false
  )
  assert.equal(state.createdRefs, 1)
})

test('simultaneous different owners acquire at most one atomic lease', async () => {
  process.env.STATE_SIGNING_SECRET ??= 'synthetic-marker-signing-key'
  const { state, client } = leaseServer()
  const results = await Promise.all([
    acquireLease(client, repository, 'workflow-call-1', baseSha),
    acquireLease(client, repository, 'workflow-call-2', baseSha)
  ])
  assert.deepEqual([...results].sort(), [false, true])
  assert.equal(state.createdRefs, 1)
})

test('a lost successful lease deletion response reconciles as released', async () => {
  process.env.STATE_SIGNING_SECRET ??= 'synthetic-marker-signing-key'
  const { state, client } = leaseServer()
  await acquireLease(client, repository, 'workflow-call-1', baseSha)
  state.loseDeleteResponse = true
  assert.equal(await releaseLease(client, repository, 'workflow-call-1'), true)
  assert.equal(state.deletedRefs, 1)
})

test('tampered lease commits are never adopted or deleted automatically', async () => {
  process.env.STATE_SIGNING_SECRET ??= 'synthetic-marker-signing-key'
  const { state, client } = leaseServer()
  await acquireLease(client, repository, 'workflow-call-1', baseSha)
  state.commits.get(state.ref)!.message += ' altered'
  state.commits.get(state.ref)!.message = state.commits
    .get(state.ref)!
    .message.replace('sentry-repair-lease:', 'sentry-repair-lease:Z')
  await assert.rejects(
    acquireLease(client, repository, 'workflow-call-2', baseSha),
    /cannot be authenticated/
  )
  await assert.rejects(
    releaseLease(client, repository, 'workflow-call-1'),
    /cannot be authenticated/
  )
  assert.equal(state.createdRefs, 1)
  assert.equal(state.deletedRefs, 0)
})
