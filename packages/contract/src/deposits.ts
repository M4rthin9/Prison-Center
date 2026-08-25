import { z } from 'zod'
import { Ulid } from './common.js'
import { PaymentView } from './payments.js'

/* ── deposit cards (ลงทะเบียนทำบัตรฝากเงิน) ────────────────────────────── */

export const DepositCardStatus = z.enum(['pending', 'approved', 'rejected', 'suspended'])
export type DepositCardStatus = z.infer<typeof DepositCardStatus>

export const DepositCard = z.object({
  id: Ulid,
  cardNo: z.string().nullable(),
  status: DepositCardStatus,
  customerId: Ulid,
  customerName: z.string(),
  customerPhone: z.string(),
  inmateId: Ulid,
  inmateCode: z.string(),
  inmateName: z.string(),
  prisonId: Ulid,
  prisonName: z.string(),
  zoneName: z.string().nullable(),
  note: z.string().nullable(),
  rejectReason: z.string().nullable(),
  approvedAt: z.number().nullable(),
  createdAt: z.number()
})
export type DepositCard = z.infer<typeof DepositCard>

export const CreateDepositCardInput = z.object({
  inmateId: Ulid,
  note: z.string().trim().max(200).optional()
})
export type CreateDepositCardInput = z.infer<typeof CreateDepositCardInput>

export const ReviewDepositCardInput = z.object({
  status: z.enum(['approved', 'rejected', 'suspended']),
  reason: z.string().trim().max(200).optional()
})
export type ReviewDepositCardInput = z.infer<typeof ReviewDepositCardInput>

/* ── deposits (ยืนยันการฝากเงิน) ───────────────────────────────────────── */

/**
 * p.7. `pending` is waiting for the relative's money; `reviewing` means the
 * slip passed and staff still have to credit the inmate's account inside the
 * facility; `completed` is that credit having happened.
 */
export const DepositStatus = z.enum([
  'pending',
  'reviewing',
  'completed',
  'rejected',
  'cancelled'
])
export type DepositStatus = z.infer<typeof DepositStatus>

export const DepositSummary = z.object({
  id: Ulid,
  depositNo: z.string(),
  status: DepositStatus,
  amountSatang: z.number().int(),
  depositorName: z.string(),
  customerId: Ulid,
  customerName: z.string(),
  customerPhone: z.string(),
  inmateId: Ulid,
  inmateCode: z.string(),
  inmateName: z.string(),
  prisonId: Ulid,
  prisonName: z.string(),
  zoneName: z.string().nullable(),
  cardNo: z.string().nullable(),
  /** Mirrors `payments.status` — the slip's half of the story. */
  paymentStatus: z.string().nullable(),
  createdAt: z.number(),
  depositedAt: z.number().nullable(),
  completedAt: z.number().nullable()
})
export type DepositSummary = z.infer<typeof DepositSummary>

export const DepositDetail = DepositSummary.extend({
  note: z.string().nullable(),
  rejectReason: z.string().nullable(),
  reviewedBy: Ulid.nullable(),
  reviewedByName: z.string().nullable(),
  reviewedAt: z.number().nullable(),
  /** The live payment, QR and all. Null once it has been retired. */
  payment: PaymentView.nullable()
})
export type DepositDetail = z.infer<typeof DepositDetail>

export const CreateDepositInput = z.object({
  inmateId: Ulid,
  /** Integer satang, like every amount in this system. */
  amountSatang: z.number().int().positive(),
  /** Defaults to the account holder's name — a deposit may be made for others. */
  depositorName: z.string().trim().min(2).max(120).optional(),
  channelId: Ulid.optional(),
  note: z.string().trim().max(200).optional()
})
export type CreateDepositInput = z.infer<typeof CreateDepositInput>

export const ReviewDepositInput = z.object({
  status: z.enum(['reviewing', 'completed', 'rejected']),
  reason: z.string().trim().max(200).optional()
})
export type ReviewDepositInput = z.infer<typeof ReviewDepositInput>

/** The p.11 dashboard tile: real pending / completed totals, per period. */
export const DepositSummaryTotals = z.object({
  from: z.number().nullable(),
  to: z.number().nullable(),
  buckets: z.array(
    z.object({
      status: DepositStatus,
      count: z.number().int(),
      totalSatang: z.number().int()
    })
  ),
  /** Money actually received (slip verified), whether or not it is credited. */
  receivedSatang: z.number().int(),
  completedSatang: z.number().int(),
  pendingCount: z.number().int(),
  reviewingCount: z.number().int()
})
export type DepositSummaryTotals = z.infer<typeof DepositSummaryTotals>
