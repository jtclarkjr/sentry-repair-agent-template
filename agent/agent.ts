import { defineAgent } from 'eve'

export default defineAgent({
  model: 'openai/gpt-6.1-sol',
  reasoning: 'high',
  modelOptions: { providerOptions: { openai: { parallelToolCalls: false } } },
  tool: false,
  // The durable coordinator uses the team's Gateway budget; incident workflows enforce their own deadlines.
  limits: {
    sessionTimeoutMs: false,
    maxInputTokensPerSession: false,
    maxOutputTokensPerSession: false,
    maxTokenCostUsdPerSession: false
  }
})
