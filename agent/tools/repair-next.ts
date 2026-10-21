import { defineWorkflowTool } from 'eve/tools'
import { z } from 'zod'
import { runRepair } from '../lib/repair/workflow'

export default defineWorkflowTool({
  description: 'Process the highest-priority pending incident in this authenticated repository. Authored code enforces evidence collection, verification, and publication. Call once per wakeup.',
  inputSchema: z.object({}),
  execute: runRepair
})
