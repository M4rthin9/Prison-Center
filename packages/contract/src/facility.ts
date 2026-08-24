import { z } from 'zod'
import { Ulid } from './common.js'

export const Zone = z.object({
  id: Ulid,
  name: z.string(),
  code: z.string().nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean()
})
export type Zone = z.infer<typeof Zone>

export const WorkDivision = z.object({
  id: Ulid,
  name: z.string(),
  code: z.string().nullable()
})

export const PrisonSummary = z.object({
  id: Ulid,
  code: z.string(),
  nameTh: z.string(),
  nameEn: z.string().nullable(),
  province: z.string().nullable(),
  zoneCount: z.number().int()
})
export type PrisonSummary = z.infer<typeof PrisonSummary>

export const PrisonDetail = PrisonSummary.extend({
  address: z.string().nullable(),
  phone: z.string().nullable(),
  zones: z.array(Zone)
})
export type PrisonDetail = z.infer<typeof PrisonDetail>

export const InmateStatus = z.enum(['active', 'transferred', 'released', 'deceased'])
export type InmateStatus = z.infer<typeof InmateStatus>

export const InmateSummary = z.object({
  id: Ulid,
  inmateCode: z.string(),
  fullName: z.string(),
  prisonId: Ulid,
  zoneId: Ulid.nullable(),
  zoneName: z.string().nullable(),
  workDivisionId: Ulid.nullable(),
  status: InmateStatus
})
export type InmateSummary = z.infer<typeof InmateSummary>
