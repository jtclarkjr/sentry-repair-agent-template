import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { fetchSandboxApi } from '../../repair/sandbox-fetch'

test('sandbox API fetch adds a deadline without replacing caller cancellation or request options', async () => {
  const original = globalThis.fetch
  const controller = new AbortController()
  controller.abort(new Error('caller stopped'))
  globalThis.fetch = Object.assign(
    async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      assert.equal(init?.method, 'POST')
      assert.equal(init?.body, '{}')
      assert.equal(init?.signal?.aborted, true)
      assert.equal(init?.signal?.reason, controller.signal.reason)
      return new Response('{}')
    },
    original
  )
  try {
    await fetchSandboxApi('https://api.vercel.com/test', {
      method: 'POST',
      body: '{}',
      signal: controller.signal
    })
  } finally {
    globalThis.fetch = original
  }
})

test('sandbox API fetch supplies an abort signal when the SDK omits one', async () => {
  const original = globalThis.fetch
  globalThis.fetch = Object.assign(
    async (
      _input: Parameters<typeof fetch>[0],
      init?: Parameters<typeof fetch>[1]
    ) => {
      assert.ok(init?.signal instanceof AbortSignal)
      assert.equal(init.signal.aborted, false)
      return new Response('{}')
    },
    original
  )
  try {
    await fetchSandboxApi('https://api.vercel.com/test')
  } finally {
    globalThis.fetch = original
  }
})
