import { z } from 'zod'

/**
 * Publicly readable settings. The full registry lives in the API
 * (modules/settings/registry.ts); this is the projection the customer app sees.
 */
export const PublicSettings = z.object({
  contact: z.object({
    phone: z.string(),
    email: z.string(),
    lineOfficial: z.string(),
    addressTh: z.string()
  }),
  order: z.object({ cutoffTime: z.string() }),
  visit: z.object({ horizonWeeks: z.number().int(), bookingCutoffHours: z.number().int() }),
  payment: z.object({ qrTtlMinutes: z.number().int() }),
  features: z.object({ lineLogin: z.boolean() })
})
export type PublicSettings = z.infer<typeof PublicSettings>
