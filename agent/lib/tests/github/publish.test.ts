import { test } from 'node:test'
import assert from 'node:assert/strict'
import { publish } from '../../github/publish'
import { repository, baseSha, marker, publicationServer } from '../fixtures/github'

test('lost branch/PR responses reconcile one verified branch and one ready pull request', async () => {
  process.env.STATE_SIGNING_SECRET ??= 'synthetic-marker-signing-key'
  const { state, client } = publicationServer()
  state.loseRefResponse = true
  state.losePullResponse = true
  const first = await publish(
    client,
    repository,
    '123',
    baseSha,
    [{ path: 'src/fix.ts', content: 'fixed' }],
    'Fix failure',
    'Verified regression'
  )
  assert.equal(first.existing, true)
  const second = await publish(
    client,
    repository,
    '123',
    baseSha,
    [{ path: 'src/fix.ts', content: 'fixed' }],
    'Fix failure',
    'Verified regression'
  )
  assert.equal(second.url, first.url)
  assert.equal(state.createdRefs, 1)
  assert.equal(state.createdCommits, 1)
  assert.equal(state.createdPulls, 1)
  assert.equal(state.pulls[0].draft, false)
})

test('partial publication resumes the signed existing branch without another commit or branch', async () => {
  process.env.STATE_SIGNING_SECRET ??= 'synthetic-marker-signing-key'
  const { state, client } = publicationServer()
  state.failPullBeforeCreate = true
  const files = [{ path: 'src/fix.ts', content: 'fixed' }]
  await assert.rejects(
    publish(client, repository, '123', baseSha, files, 'Fix', 'Verified'),
    /connection ended/
  )
  state.failPullBeforeCreate = false
  await publish(client, repository, '123', baseSha, files, 'Fix', 'Verified')
  assert.equal(state.createdRefs, 1)
  assert.equal(state.createdCommits, 1)
  assert.equal(state.createdPulls, 1)
})

test('a regenerated different candidate cannot create a duplicate branch after partial publication', async () => {
  process.env.STATE_SIGNING_SECRET ??= 'synthetic-marker-signing-key'
  const { state, client } = publicationServer()
  state.failPullBeforeCreate = true
  await assert.rejects(
    publish(
    client,
      repository,
      '123',
      baseSha,
      [{ path: 'src/fix.ts', content: 'first fix' }],
      'Fix',
      'Verified'
    ),
    /connection ended/
  )
  state.failPullBeforeCreate = false
  await assert.rejects(
    publish(
    client,
      repository,
      '123',
      baseSha,
      [{ path: 'src/fix.ts', content: 'different fix' }],
      'Fix',
      'Verified'
    ),
    /no longer matches/
  )
  assert.equal(state.createdRefs, 1)
  assert.equal(state.createdCommits, 1)
  assert.equal(state.createdPulls, 0)
})

test('base advancement cannot create another branch while an older publication is open or partial', async () => {
  process.env.STATE_SIGNING_SECRET ??= 'synthetic-marker-signing-key'
  for (const partial of [true, false]) {
    const { state, client } = publicationServer()
    state.failPullBeforeCreate = partial
    const first = publish(
    client,
      repository,
      '123',
      baseSha,
      [{ path: 'src/fix.ts', content: 'fixed' }],
      'Fix',
      'Verified'
    )
    if (partial) await assert.rejects(first, /connection ended/)
    else await first
    state.failPullBeforeCreate = false
    state.defaultBase = 'd'.repeat(40)
    await assert.rejects(
      publish(
    client,
        repository,
        '123',
        state.defaultBase,
        [{ path: 'src/fix.ts', content: 'new fix' }],
        'Fix',
        'Verified'
      ),
      /prior-base repair branch/
    )
    assert.equal(state.createdRefs, 1)
    assert.equal(state.createdPulls, partial ? 0 : 1)
  }
})

test('tampered branches and closed or draft existing PRs never count as verified publication', async () => {
  process.env.STATE_SIGNING_SECRET ??= 'synthetic-marker-signing-key'
  for (const tamper of ['tree', 'closed', 'draft']) {
    const { state, client } = publicationServer()
    const files = [{ path: 'src/fix.ts', content: 'fixed' }]
    await publish(client, repository, '123', baseSha, files, 'Fix', 'Verified')
    if (tamper === 'tree')
      state.commits.get(state.ref)!.tree.sha = 'modified-tree'
    if (tamper === 'closed') state.pulls[0].state = 'closed'
    if (tamper === 'draft') state.pulls[0].draft = true
    await assert.rejects(
      publish(client, repository, '123', baseSha, files, 'Fix', 'Verified'),
      /no longer matches|manual review/
    )
    assert.equal(state.createdPulls, 1)
  }
})
