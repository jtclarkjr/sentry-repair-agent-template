import { defineAgent } from 'eve'
export default defineAgent({
  description:
    'Investigate one production incident and propose a minimal source patch and independent regression test. No publishing privileges.',
  model: 'openai/gpt-6.1-sol',
  reasoning: 'high',
  tool: false,
  limits: { sessionTimeoutMs: 3_600_000 }
})
