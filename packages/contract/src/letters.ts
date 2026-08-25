import { z } from 'zod'
import { Ulid } from './common.js'
import { PaymentView } from './payments.js'

/* ── packages + credits (p.6, p.12) ────────────────────────────────────── */

/** Which way the paper moves. Credits are held per direction, never pooled. */
export const LetterDirection = z.enum(['to_prison', 'to_home'])
export type LetterDirection = z.infer<typeof LetterDirection>

export const LetterPackage = z.object({
  id: Ulid,
  /** NULL = department-wide package, offered by every facility. */
  prisonId: Ulid.nullable(),
  prisonName: z.string().nullable(),
  name: z.string(),
  direction: LetterDirection,
  priceSatang: z.number().int(),
  /** How many letters the package is worth — p.12: ฿100 → 10 ฉบับ. */
  quota: z.number().int(),
  isActive: z.boolean(),
  sortOrder: z.number().int(),
  note: z.string().nullable()
})
export type LetterPackage = z.infer<typeof LetterPackage>

export const CreateLetterPackageInput = z.object({
  prisonId: Ulid.nullable().optional(),
  name: z.string().trim().min(2).max(120),
  direction: LetterDirection,
  priceSatang: z.number().int().min(0),
  quota: z.number().int().min(1).max(1000),
  isActive: z.boolean().default(true),
  sortOrder: z.number().int().min(0).default(100),
  note: z.string().trim().max(200).nullable().optional()
})
export type CreateLetterPackageInput = z.infer<typeof CreateLetterPackageInput>

export const UpdateLetterPackageInput = CreateLetterPackageInput.partial()
export type UpdateLetterPackageInput = z.infer<typeof UpdateLetterPackageInput>

/**
 * Credits are a ledger, not a counter (§4.5). The balance the app shows is the
 * newest `balanceAfter` for the pair, never a stored column.
 */
export const LetterCreditBalance = z.object({
  toPrison: z.number().int(),
  toHome: z.number().int()
})
export type LetterCreditBalance = z.infer<typeof LetterCreditBalance>

export const LetterCreditReason = z.enum([
  'purchase',
  'consume',
  'refund',
  'admin_adjust',
  'expiry'
])
export type LetterCreditReason = z.infer<typeof LetterCreditReason>

export const LetterCreditEntry = z.object({
  id: Ulid,
  direction: LetterDirection,
  delta: z.number().int(),
  balanceAfter: z.number().int(),
  reason: LetterCreditReason,
  refType: z.string().nullable(),
  refId: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.number()
})
export type LetterCreditEntry = z.infer<typeof LetterCreditEntry>

export const LetterCredits = z.object({
  balance: LetterCreditBalance,
  /** Most recent movements — the `ประวัติการเติม` list on p.4. */
  ledger: z.array(LetterCreditEntry)
})
export type LetterCredits = z.infer<typeof LetterCredits>

/* ── package purchases — the third purpose on the payment spine ────────── */

export const LetterPurchaseStatus = z.enum(['pending', 'paid', 'cancelled', 'refunded'])
export type LetterPurchaseStatus = z.infer<typeof LetterPurchaseStatus>

export const LetterPurchaseSummary = z.object({
  id: Ulid,
  purchaseNo: z.string(),
  status: LetterPurchaseStatus,
  packageId: Ulid.nullable(),
  packageName: z.string(),
  direction: LetterDirection,
  quota: z.number().int(),
  priceSatang: z.number().int(),
  customerId: Ulid,
  customerName: z.string(),
  customerPhone: z.string(),
  prisonId: Ulid,
  prisonName: z.string(),
  /** Mirrors `payments.status` — the slip's half of the story. */
  paymentStatus: z.string().nullable(),
  createdAt: z.number(),
  paidAt: z.number().nullable()
})
export type LetterPurchaseSummary = z.infer<typeof LetterPurchaseSummary>

export const LetterPurchaseDetail = LetterPurchaseSummary.extend({
  /** The live payment, QR and all. Null once it has been retired. */
  payment: PaymentView.nullable()
})
export type LetterPurchaseDetail = z.infer<typeof LetterPurchaseDetail>

export const PurchaseLetterPackageInput = z.object({
  prisonId: Ulid.optional(),
  channelId: Ulid.optional()
})
export type PurchaseLetterPackageInput = z.infer<typeof PurchaseLetterPackageInput>

/* ── letters (§4.5) ────────────────────────────────────────────────────── */

/**
 * `draft` costs nothing; the credit is consumed at `queued`. From there the
 * paper trail is print → dispatch → delivered, one status per real event.
 */
export const LetterStatus = z.enum([
  'draft',
  'queued',
  'pending_print',
  'printed',
  'dispatched',
  'delivered',
  'rejected'
])
export type LetterStatus = z.infer<typeof LetterStatus>

export const LetterAttachment = z.object({
  id: Ulid,
  letterId: Ulid,
  sortOrder: z.number().int(),
  /** Served through the API, never from a public bucket URL. */
  url: z.string(),
  createdAt: z.number()
})
export type LetterAttachment = z.infer<typeof LetterAttachment>

export const LetterSummary = z.object({
  id: Ulid,
  letterNo: z.string(),
  direction: LetterDirection,
  status: LetterStatus,
  customerId: Ulid.nullable(),
  customerName: z.string().nullable(),
  inmateId: Ulid.nullable(),
  inmateCode: z.string().nullable(),
  inmateName: z.string().nullable(),
  prisonId: Ulid,
  prisonName: z.string().nullable(),
  zoneId: Ulid.nullable(),
  zoneName: z.string().nullable(),
  /** First line or so — enough for a list row without shipping the body. */
  preview: z.string(),
  attachmentCount: z.number().int(),
  batchId: Ulid.nullable(),
  batchNo: z.string().nullable(),
  replyToLetterId: Ulid.nullable(),
  replyToLetterNo: z.string().nullable(),
  hasReply: z.boolean(),
  createdAt: z.number(),
  queuedAt: z.number().nullable(),
  printedAt: z.number().nullable(),
  dispatchedAt: z.number().nullable(),
  deliveredAt: z.number().nullable()
})
export type LetterSummary = z.infer<typeof LetterSummary>

export const LetterDetail = LetterSummary.extend({
  bodyText: z.string(),
  rejectedReason: z.string().nullable(),
  /** A scanned reply carries an image, not typed text. */
  scanUrl: z.string().nullable(),
  attachments: z.array(LetterAttachment),
  printedByName: z.string().nullable()
})
export type LetterDetail = z.infer<typeof LetterDetail>

export const CreateLetterInput = z.object({
  inmateId: Ulid,
  bodyText: z.string().trim().max(20_000).default('')
})
export type CreateLetterInput = z.infer<typeof CreateLetterInput>

export const UpdateLetterInput = z.object({
  bodyText: z.string().trim().max(20_000)
})
export type UpdateLetterInput = z.infer<typeof UpdateLetterInput>

/* ── print queue + batches ─────────────────────────────────────────────── */

export const LetterBatchStatus = z.enum(['queued', 'rendering', 'ready', 'printed', 'failed'])
export type LetterBatchStatus = z.infer<typeof LetterBatchStatus>

/** `pdf` when a real browser rendered it; `html` is the print-it-yourself fallback. */
export const LetterBatchFormat = z.enum(['pdf', 'html'])
export type LetterBatchFormat = z.infer<typeof LetterBatchFormat>

export const LetterBatch = z.object({
  id: Ulid,
  batchNo: z.string(),
  status: LetterBatchStatus,
  format: LetterBatchFormat.nullable(),
  prisonId: Ulid,
  prisonName: z.string().nullable(),
  zoneId: Ulid.nullable(),
  zoneName: z.string().nullable(),
  letterCount: z.number().int(),
  fileUrl: z.string().nullable(),
  lastError: z.string().nullable(),
  generatedByName: z.string().nullable(),
  generatedAt: z.number().nullable(),
  printedAt: z.number().nullable(),
  createdAt: z.number()
})
export type LetterBatch = z.infer<typeof LetterBatch>

export const CreateLetterBatchInput = z.object({
  prisonId: Ulid.optional(),
  /** One แดน per batch is the normal case — that is how the paper is walked. */
  zoneId: Ulid.nullable().optional(),
  limit: z.number().int().min(1).max(200).optional()
})
export type CreateLetterBatchInput = z.infer<typeof CreateLetterBatchInput>

export const UpdateLetterStatusInput = z.object({
  status: z.enum(['printed', 'dispatched', 'delivered', 'rejected']),
  reason: z.string().trim().max(200).optional()
})
export type UpdateLetterStatusInput = z.infer<typeof UpdateLetterStatusInput>

/* ── scan-reply intake (แบบฟอร์มตอบกลับ, p.6) ───────────────────────────── */

export const ScanReplyResult = z.object({
  /** The `letter_no` read off the printed reply form's QR. */
  matchedLetterNo: z.string().nullable(),
  letter: LetterDetail.nullable(),
  /** True when the reply is stored but the family has no `to_home` credit yet. */
  awaitingCredit: z.boolean(),
  message: z.string()
})
export type ScanReplyResult = z.infer<typeof ScanReplyResult>

export const ScanReplyInput = z.object({
  /** Override when the QR is unreadable and staff type the number by hand. */
  letterNo: z.string().trim().max(40).optional()
})
export type ScanReplyInput = z.infer<typeof ScanReplyInput>

/* ── dashboard tile / p.12 letter report ───────────────────────────────── */

export const LetterSummaryTotals = z.object({
  from: z.number().nullable(),
  to: z.number().nullable(),
  buckets: z.array(
    z.object({
      direction: LetterDirection,
      status: LetterStatus,
      count: z.number().int()
    })
  ),
  /** Waiting for paper: `queued` + `pending_print`. */
  awaitingPrintCount: z.number().int(),
  printedCount: z.number().int(),
  deliveredCount: z.number().int(),
  creditsSoldSatang: z.number().int()
})
export type LetterSummaryTotals = z.infer<typeof LetterSummaryTotals>
