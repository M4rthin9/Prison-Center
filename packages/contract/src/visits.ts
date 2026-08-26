import { z } from 'zod'
import { Ulid } from './common.js'

/** `HH:MM`, Bangkok wall clock. A round is a time of day, never a timestamp. */
export const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'รูปแบบเวลาไม่ถูกต้อง (HH:MM)')
/** `YYYY-MM-DD` in Bangkok local time. */
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'รูปแบบวันที่ไม่ถูกต้อง')

export const VisitSession = z.enum(['morning', 'afternoon'])
export type VisitSession = z.infer<typeof VisitSession>

export const VisitScheduleSource = z.enum(['template', 'manual'])
export type VisitScheduleSource = z.infer<typeof VisitScheduleSource>

export const VisitBookingStatus = z.enum([
  'pending',
  'confirmed',
  'cancelled',
  'checked_in',
  'no_show'
])
export type VisitBookingStatus = z.infer<typeof VisitBookingStatus>

/* ── rounds (รอบเยี่ยม) ─────────────────────────────────────────────────── */

export const VisitRound = z.object({
  id: Ulid,
  prisonId: Ulid,
  roundNo: z.number().int(),
  label: z.string(),
  session: VisitSession,
  startTime: HHMM,
  endTime: HHMM,
  sortOrder: z.number().int(),
  isActive: z.boolean()
})
export type VisitRound = z.infer<typeof VisitRound>

export const CreateVisitRoundInput = z.object({
  prisonId: Ulid.optional(),
  roundNo: z.number().int().min(1).max(99),
  label: z.string().trim().min(1).max(60),
  session: VisitSession.default('morning'),
  startTime: HHMM,
  endTime: HHMM,
  sortOrder: z.number().int().min(0).max(999).optional()
})
export type CreateVisitRoundInput = z.infer<typeof CreateVisitRoundInput>

export const UpdateVisitRoundInput = CreateVisitRoundInput.omit({
  prisonId: true,
  roundNo: true
})
  .partial()
  .extend({ roundNo: z.number().int().min(1).max(99).optional(), isActive: z.boolean().optional() })
export type UpdateVisitRoundInput = z.infer<typeof UpdateVisitRoundInput>

/* ── weekly template (the p.12 grid, as a starting point) ──────────────── */

export const VisitTemplateCell = z.object({
  id: Ulid,
  prisonId: Ulid,
  weekday: z.number().int().min(0).max(6),
  roundId: Ulid,
  roundLabel: z.string(),
  session: VisitSession,
  startTime: HHMM,
  endTime: HHMM,
  zoneId: Ulid,
  zoneName: z.string(),
  capacity: z.number().int(),
  isActive: z.boolean()
})
export type VisitTemplateCell = z.infer<typeof VisitTemplateCell>

export const UpsertVisitTemplateInput = z.object({
  prisonId: Ulid.optional(),
  weekday: z.number().int().min(0).max(6),
  roundId: Ulid,
  zoneId: Ulid,
  capacity: z.number().int().min(0).max(9999),
  isActive: z.boolean().optional()
})
export type UpsertVisitTemplateInput = z.infer<typeof UpsertVisitTemplateInput>

/* ── the materialized calendar ─────────────────────────────────────────── */

export const VisitScheduleDay = z.object({
  id: Ulid,
  prisonId: Ulid,
  date: IsoDate,
  roundId: Ulid,
  roundNo: z.number().int(),
  roundLabel: z.string(),
  session: VisitSession,
  startTime: HHMM,
  endTime: HHMM,
  zoneId: Ulid,
  zoneName: z.string(),
  capacity: z.number().int(),
  bookedCount: z.number().int(),
  isClosed: z.boolean(),
  note: z.string().nullable(),
  source: VisitScheduleSource
})
export type VisitScheduleDay = z.infer<typeof VisitScheduleDay>

/** What the week-grid editor reads: rounds down the left, dates across the top. */
export const VisitScheduleGrid = z.object({
  prisonId: Ulid.nullable(),
  from: IsoDate,
  to: IsoDate,
  dates: z.array(IsoDate),
  rounds: z.array(VisitRound),
  zones: z.array(z.object({ id: Ulid, name: z.string() })),
  cells: z.array(VisitScheduleDay)
})
export type VisitScheduleGrid = z.infer<typeof VisitScheduleGrid>

export const CreateVisitScheduleDayInput = z.object({
  prisonId: Ulid.optional(),
  date: IsoDate,
  roundId: Ulid,
  zoneId: Ulid,
  capacity: z.number().int().min(0).max(9999),
  note: z.string().trim().max(200).optional()
})
export type CreateVisitScheduleDayInput = z.infer<typeof CreateVisitScheduleDayInput>

export const UpdateVisitScheduleDayInput = z.object({
  zoneId: Ulid.optional(),
  capacity: z.number().int().min(0).max(9999).optional(),
  isClosed: z.boolean().optional(),
  note: z.string().trim().max(200).nullable().optional()
})
export type UpdateVisitScheduleDayInput = z.infer<typeof UpdateVisitScheduleDayInput>

export const GenerateVisitScheduleInput = z.object({
  prisonId: Ulid.optional(),
  /** Defaults to `visit.horizon_weeks`. */
  weeks: z.number().int().min(1).max(12).optional(),
  from: IsoDate.optional()
})
export type GenerateVisitScheduleInput = z.infer<typeof GenerateVisitScheduleInput>

export const GenerateVisitScheduleResult = z.object({
  from: IsoDate,
  to: IsoDate,
  created: z.number().int(),
  /** Rows that already existed — template or manual — and were left alone. */
  skipped: z.number().int()
})
export type GenerateVisitScheduleResult = z.infer<typeof GenerateVisitScheduleResult>

export const CloseVisitDatesInput = z.object({
  prisonId: Ulid.optional(),
  from: IsoDate,
  to: IsoDate,
  isClosed: z.boolean().default(true),
  note: z.string().trim().max(200).optional()
})
export type CloseVisitDatesInput = z.infer<typeof CloseVisitDatesInput>

/* ── availability (what a relative sees) ───────────────────────────────── */

export const VisitSlot = z.object({
  scheduleDayId: Ulid,
  date: IsoDate,
  roundId: Ulid,
  roundNo: z.number().int(),
  roundLabel: z.string(),
  session: VisitSession,
  startTime: HHMM,
  endTime: HHMM,
  startsAt: z.number(),
  zoneId: Ulid,
  zoneName: z.string(),
  capacity: z.number().int(),
  bookedCount: z.number().int(),
  available: z.number().int(),
  isClosed: z.boolean(),
  /** False once the facility's booking cutoff has passed for this slot. */
  isBookable: z.boolean(),
  note: z.string().nullable()
})
export type VisitSlot = z.infer<typeof VisitSlot>

export const VisitAvailability = z.object({
  inmateId: Ulid,
  inmateName: z.string(),
  zoneId: Ulid.nullable(),
  zoneName: z.string().nullable(),
  from: IsoDate,
  to: IsoDate,
  cutoffHours: z.number().int(),
  slots: z.array(VisitSlot)
})
export type VisitAvailability = z.infer<typeof VisitAvailability>

/* ── bookings ──────────────────────────────────────────────────────────── */

export const VisitBookingSummary = z.object({
  id: Ulid,
  bookingNo: z.string(),
  status: VisitBookingStatus,
  customerId: Ulid,
  customerName: z.string(),
  customerPhone: z.string(),
  inmateId: Ulid,
  inmateCode: z.string(),
  inmateName: z.string(),
  prisonId: Ulid,
  prisonName: z.string(),
  zoneName: z.string().nullable(),
  visitDate: IsoDate,
  roundLabel: z.string(),
  session: VisitSession,
  startTime: HHMM,
  endTime: HHMM,
  startsAt: z.number(),
  visitorName: z.string(),
  contactPhone: z.string(),
  visitorCount: z.number().int(),
  checkedInAt: z.number().nullable(),
  createdAt: z.number()
})
export type VisitBookingSummary = z.infer<typeof VisitBookingSummary>

export const VisitBookingDetail = VisitBookingSummary.extend({
  scheduleDayId: Ulid,
  roundId: Ulid,
  lineIdText: z.string().nullable(),
  note: z.string().nullable(),
  cancelledReason: z.string().nullable(),
  cancelledAt: z.number().nullable(),
  /** True while the facility's cutoff still allows the family to cancel. */
  canCancel: z.boolean()
})
export type VisitBookingDetail = z.infer<typeof VisitBookingDetail>

export const CreateVisitBookingInput = z.object({
  inmateId: Ulid,
  scheduleDayId: Ulid,
  visitorName: z.string().trim().min(2).max(120),
  contactPhone: z.string().trim().min(9).max(20),
  lineIdText: z.string().trim().max(60).optional(),
  visitorCount: z.number().int().min(1).max(10).optional(),
  note: z.string().trim().max(200).optional()
})
export type CreateVisitBookingInput = z.infer<typeof CreateVisitBookingInput>

export const UpdateVisitBookingStatusInput = z.object({
  status: z.enum(['confirmed', 'checked_in', 'cancelled', 'no_show']),
  reason: z.string().trim().max(200).optional()
})
export type UpdateVisitBookingStatusInput = z.infer<typeof UpdateVisitBookingStatusInput>

/** The p.11 dashboard tile / p.12 report spine. */
export const VisitSummaryTotals = z.object({
  from: IsoDate.nullable(),
  to: IsoDate.nullable(),
  buckets: z.array(
    z.object({ status: VisitBookingStatus, count: z.number().int() })
  ),
  bookedCount: z.number().int(),
  checkedInCount: z.number().int(),
  cancelledCount: z.number().int(),
  noShowCount: z.number().int(),
  capacityTotal: z.number().int(),
  utilisation: z.number()
})
export type VisitSummaryTotals = z.infer<typeof VisitSummaryTotals>
