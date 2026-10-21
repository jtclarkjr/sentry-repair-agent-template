import { z } from 'zod'

const timestampSchema = z.iso.datetime({ offset: true })
const countSchema = z.number().int().nonnegative().nullable()
export const countWindowSchema = z.object({
  events: countSchema,
  affectedUsers: countSchema
})
export type CountWindow = z.infer<typeof countWindowSchema>
export const incidentVolumeSchema = z.object({
  '15m': countWindowSchema,
  '1h': countWindowSchema,
  '24h': countWindowSchema,
  previous15m: countWindowSchema
})
export type IncidentVolume = z.infer<typeof incidentVolumeSchema>

export const incidentEvidenceSchema = z
  .object({
    org: z.string().min(1),
    project: z.string().min(1),
    issueId: z.string().min(1),
    title: z.string().min(1),
    url: z.url({ protocol: /^https$/ }),
    firstSeen: timestampSchema,
    lastSeen: timestampSchema,
    releaseSha: z
      .string()
      .regex(/^[a-f\d]{7,40}$/i)
      .optional(),
    environment: z.string().nullable().default(null),
    volumeObservedAt: timestampSchema.optional(),
    volume: incidentVolumeSchema
  })
  .refine(
    (value) => Date.parse(value.firstSeen) <= Date.parse(value.lastSeen),
    {
      message: 'firstSeen must not follow lastSeen',
      path: ['firstSeen']
    }
  )
export type IncidentEvidence = z.infer<typeof incidentEvidenceSchema>

export const flowAssessmentSchema = z
  .object({
    flowId: z.string().min(1),
    impact: z.enum(['blocked', 'degraded', 'unaffected', 'unknown']),
    confidence: z.enum(['verified', 'probable', 'unknown']).default('unknown'),
    evidence: z.array(z.string().trim().min(1).max(4_000)).max(20).default([]),
    cohort: z.string().max(1_000).optional(),
    workaround: z.enum(['available', 'unavailable', 'unknown']).optional(),
    workaroundDetails: z.string().max(1_000).optional(),
    minor: z.boolean().optional(),
    systemWide: z.boolean().default(false),
    dataLoss: z.boolean().default(false),
    checkedAt: timestampSchema.optional()
  })
  .superRefine((value, context) => {
    if (
      (value.impact !== 'unknown' || value.systemWide || value.dataLoss) &&
      !value.evidence.length
    ) {
      context.addIssue({
        code: 'custom',
        path: ['evidence'],
        message: 'Impact claims require supporting evidence'
      })
    }
    if (value.systemWide && value.impact !== 'blocked') {
      context.addIssue({
        code: 'custom',
        path: ['systemWide'],
        message: 'A system-wide blockage requires blocked impact'
      })
    }
  })
export type FlowAssessment = Omit<
  z.infer<typeof flowAssessmentSchema>,
  'confidence'
> & {
  confidence?: 'verified' | 'probable' | 'unknown'
}

export const rootCauseSchema = z
  .object({
    confidence: z.enum(['confirmed', 'probable', 'undetermined']),
    summary: z.string().trim().min(1).max(12_000),
    trigger: z.string().trim().min(1).max(4_000).optional(),
    code: z.array(z.string().trim().min(1).max(1_000)).max(20).optional(),
    evidence: z.array(z.string().trim().min(1).max(4_000)).max(30).default([]),
    unknowns: z.array(z.string().trim().min(1).max(4_000)).max(20).default([])
  })
  .refine(
    (value) => value.confidence === 'undetermined' || value.evidence.length > 0,
    {
      message: 'A proposed root cause requires supporting evidence',
      path: ['evidence']
    }
  )
export type RootCause = z.infer<typeof rootCauseSchema>

export const prioritySchema = z.enum(['P0', 'P1', 'P2', 'P3'])
export type Priority = z.infer<typeof prioritySchema>
export const priorityAssessmentSchema = z.object({
  priority: prioritySchema,
  provisional: z.boolean(),
  reasons: z.array(z.string()),
  assessedAt: timestampSchema,
  lastEscalatedAt: timestampSchema,
  downgradeAfter: timestampSchema.optional(),
  recoveryRequired: z.boolean().optional(),
  recoveryFlowIds: z.array(z.string()).optional()
})
export type PriorityAssessment = z.infer<typeof priorityAssessmentSchema>
