import { defineSandbox } from 'eve/sandbox'
import { VercelSandbox } from 'eve/sandbox/vercel'
import { installationNetwork } from '../../lib/repair/sandbox'
import { fetchSandboxApi } from '../../lib/repair/sandbox-fetch'
export const environment = VercelSandbox.environment({
  region: 'hnd1',
  fetch: fetchSandboxApi
})
export default defineSandbox(() =>
  environment.open({
    timeout: 3_600_000,
    resources: { vcpus: 4 },
    networkPolicy: installationNetwork
  })
)
