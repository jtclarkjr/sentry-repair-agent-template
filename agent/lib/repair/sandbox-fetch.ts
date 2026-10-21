// Sandbox's bundled SDK has no response-body timeout; keep control-plane requests bounded.
export const fetchSandboxApi = Object.assign(
  (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1]
  ) => {
    const timeout = AbortSignal.timeout(120_000)
    const signal = init?.signal
      ? AbortSignal.any([init.signal, timeout])
      : timeout
    return globalThis.fetch(input, { ...init, signal })
  },
  globalThis.fetch
)
