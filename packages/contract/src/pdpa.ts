import { z } from 'zod'

/** One retention window's worth of work, as reported by the job. */
export const RetentionAction = z.object({
  key: z.string(),
  label: z.string(),
  cutoffAt: z.number().int(),
  rows: z.number().int(),
  files: z.number().int()
})
export type RetentionAction = z.infer<typeof RetentionAction>

export const RetentionReport = z.object({
  at: z.number().int(),
  /** True means nothing was deleted — the run only reported what it would do. */
  dryRun: z.boolean(),
  /** The `pdpa.retention.enabled` setting at the time of the run. */
  enabled: z.boolean(),
  actions: z.array(RetentionAction),
  totalRows: z.number().int(),
  totalFiles: z.number().int()
})
export type RetentionReport = z.infer<typeof RetentionReport>

export const RunRetentionInput = z.object({
  /**
   * Omit to follow the settings. `false` forces a real purge and is refused
   * unless `pdpa.retention.enabled` is on.
   */
  dryRun: z.boolean().optional()
})
export type RunRetentionInput = z.infer<typeof RunRetentionInput>
