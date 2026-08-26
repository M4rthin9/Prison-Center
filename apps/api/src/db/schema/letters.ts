import { relations } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { bool, id, satang, timestamps, ts } from './_shared.js'
import { inmates, prisons, zones } from './facility.js'
import { customers } from './people.js'
import { payments } from './payments.js'

/**
 * §4.5 / pp. 6, 12 — Domimail. A prepaid coupon quota, a print queue, and a
 * scanned reply that finds its way back to the right family through the QR
 * printed on the outgoing sheet.
 */

/** p.12: ฿100 → 10 ฉบับ, in each direction. Credits never cross directions. */
export type LetterDirection = 'to_prison' | 'to_home'

export type LetterCreditReason = 'purchase' | 'consume' | 'refund' | 'admin_adjust' | 'expiry'

export type LetterStatus =
  'draft' | 'queued' | 'pending_print' | 'printed' | 'dispatched' | 'delivered' | 'rejected'

export type LetterPurchaseStatus = 'pending' | 'paid' | 'cancelled' | 'refunded'

export type LetterBatchStatus = 'queued' | 'rendering' | 'ready' | 'printed' | 'failed'

/** What actually came out of the renderer — a real PDF, or the HTML fallback. */
export type LetterBatchFormat = 'pdf' | 'html'

export const letterPackages = sqliteTable(
  'letter_packages',
  {
    id: id(),
    /** NULL = department-wide, exactly like a payment channel. */
    prisonId: text('prison_id').references(() => prisons.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    direction: text('direction').$type<LetterDirection>().notNull(),
    priceSatang: satang('price_satang').notNull(),
    quota: integer('quota').notNull(),
    isActive: bool('is_active', true),
    sortOrder: integer('sort_order').notNull().default(100),
    note: text('note'),
    ...timestamps(),
    createdBy: text('created_by'),
    updatedBy: text('updated_by')
  },
  (t) => [
    uniqueIndex('uq_letter_packages_name').on(t.prisonId, t.name),
    index('idx_letter_packages_offer').on(t.prisonId, t.direction, t.isActive, t.sortOrder)
  ]
)

/**
 * Buying a package is the third `purpose` on the Phase 2 payment spine. The
 * row exists before the money does so the payment has something to point at,
 * and the credits are granted only when the slip passes.
 */
export const letterPurchases = sqliteTable(
  'letter_purchases',
  {
    id: id(),
    /** `{PRISON_CODE}-M{YYMM}-{SEQ}` — M for mail. */
    purchaseNo: text('purchase_no').notNull(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    packageId: text('package_id').references(() => letterPackages.id, { onDelete: 'set null' }),
    prisonId: text('prison_id')
      .notNull()
      .references(() => prisons.id, { onDelete: 'restrict' }),
    /** Snapshotted: a package renamed or repriced later must not rewrite this. */
    packageNameSnapshot: text('package_name_snapshot').notNull(),
    direction: text('direction').$type<LetterDirection>().notNull(),
    quota: integer('quota').notNull(),
    priceSatang: satang('price_satang').notNull(),
    paymentId: text('payment_id').references(() => payments.id, { onDelete: 'set null' }),
    status: text('status').$type<LetterPurchaseStatus>().notNull().default('pending'),
    paidAt: ts('paid_at'),
    ...timestamps(),
    updatedBy: text('updated_by')
  },
  (t) => [
    uniqueIndex('uq_letter_purchases_no').on(t.purchaseNo),
    index('idx_letter_purchases_customer').on(t.customerId, t.createdAt),
    index('idx_letter_purchases_prison').on(t.prisonId, t.status, t.createdAt),
    index('idx_letter_purchases_payment').on(t.paymentId)
  ]
)

/**
 * Credits are a **ledger, not a counter** (§4.5). Balance is the newest
 * `balance_after` for a (customer, direction) pair, written inside the same
 * transaction as the row that consumes it — a bare `credits_remaining` column
 * drifts the first time a print job dies halfway.
 */
export const letterCreditLedger = sqliteTable(
  'letter_credit_ledger',
  {
    id: id(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /** Which inmate a `consume` was spent on. Informational: credits are pooled. */
    inmateId: text('inmate_id').references(() => inmates.id, { onDelete: 'set null' }),
    prisonId: text('prison_id').references(() => prisons.id, { onDelete: 'restrict' }),
    direction: text('direction').$type<LetterDirection>().notNull(),
    delta: integer('delta').notNull(),
    balanceAfter: integer('balance_after').notNull(),
    reason: text('reason').$type<LetterCreditReason>().notNull(),
    refType: text('ref_type'),
    refId: text('ref_id'),
    note: text('note'),
    createdAt: ts('created_at')
      .notNull()
      .$defaultFn(() => Date.now()),
    createdBy: text('created_by')
  },
  (t) => [
    // §5: the balance read is `ORDER BY created_at DESC LIMIT 1` on this index.
    index('idx_credit_ledger_latest').on(t.customerId, t.direction, t.createdAt),
    index('idx_credit_ledger_ref').on(t.refType, t.refId)
  ]
)

/**
 * One batch is one stack of paper for one แดน. The PDF is rendered by a job,
 * so a slow browser never blocks the staff member who pressed the button.
 */
export const letterBatches = sqliteTable(
  'letter_batches',
  {
    id: id(),
    /** `{PRISON_CODE}-B{YYMM}-{SEQ}`. */
    batchNo: text('batch_no').notNull(),
    prisonId: text('prison_id')
      .notNull()
      .references(() => prisons.id, { onDelete: 'restrict' }),
    zoneId: text('zone_id').references(() => zones.id, { onDelete: 'set null' }),
    zoneNameSnapshot: text('zone_name_snapshot'),
    letterCount: integer('letter_count').notNull().default(0),
    status: text('status').$type<LetterBatchStatus>().notNull().default('queued'),
    format: text('format').$type<LetterBatchFormat>(),
    pdfKey: text('pdf_key'),
    lastError: text('last_error'),
    generatedBy: text('generated_by'),
    generatedAt: ts('generated_at'),
    printedBy: text('printed_by'),
    printedAt: ts('printed_at'),
    ...timestamps()
  },
  (t) => [
    uniqueIndex('uq_letter_batches_no').on(t.batchNo),
    index('idx_letter_batches_prison').on(t.prisonId, t.status, t.createdAt)
  ]
)

export const letters = sqliteTable(
  'letters',
  {
    id: id(),
    /** `{PRISON_CODE}-L{YYMM}-{SEQ}` — this is what the reply QR encodes. */
    letterNo: text('letter_no').notNull(),
    direction: text('direction').$type<LetterDirection>().notNull(),

    senderCustomerId: text('sender_customer_id').references(() => customers.id, {
      onDelete: 'set null'
    }),
    senderInmateId: text('sender_inmate_id').references(() => inmates.id, {
      onDelete: 'set null'
    }),
    recipientInmateId: text('recipient_inmate_id').references(() => inmates.id, {
      onDelete: 'set null'
    }),
    recipientCustomerId: text('recipient_customer_id').references(() => customers.id, {
      onDelete: 'set null'
    }),

    prisonId: text('prison_id')
      .notNull()
      .references(() => prisons.id, { onDelete: 'restrict' }),
    /** Snapshotted at compose time — a transfer must not re-file last month. */
    zoneId: text('zone_id').references(() => zones.id, { onDelete: 'set null' }),
    zoneNameSnapshot: text('zone_name_snapshot'),
    inmateCodeSnapshot: text('inmate_code_snapshot'),
    inmateNameSnapshot: text('inmate_name_snapshot'),
    customerNameSnapshot: text('customer_name_snapshot'),

    bodyText: text('body_text').notNull().default(''),
    /** A scanned reply is an image, not text. */
    scanImageKey: text('scan_image_key'),
    attachmentCount: integer('attachment_count').notNull().default(0),

    status: text('status').$type<LetterStatus>().notNull().default('draft'),
    batchId: text('batch_id').references(() => letterBatches.id, { onDelete: 'set null' }),
    queuedAt: ts('queued_at'),
    printedAt: ts('printed_at'),
    printedBy: text('printed_by'),
    dispatchedAt: ts('dispatched_at'),
    deliveredAt: ts('delivered_at'),
    /** Set on the outgoing letter this one answers (p.6 แบบฟอร์มตอบกลับ). */
    replyToLetterId: text('reply_to_letter_id'),
    rejectedReason: text('rejected_reason'),
    ...timestamps(),
    updatedBy: text('updated_by')
  },
  (t) => [
    uniqueIndex('uq_letters_letter_no').on(t.letterNo),
    // §5: exactly what the print queue reads.
    index('idx_letters_print_queue').on(t.prisonId, t.zoneId, t.status, t.createdAt),
    index('idx_letters_sender').on(t.senderCustomerId, t.createdAt),
    index('idx_letters_recipient').on(t.recipientCustomerId, t.createdAt),
    index('idx_letters_inmate').on(t.recipientInmateId, t.createdAt),
    /** Department-wide report range scan (§7). */
    index('idx_letters_created').on(t.createdAt),
    index('idx_letters_batch').on(t.batchId),
    index('idx_letters_reply_to').on(t.replyToLetterId)
  ]
)

export const letterAttachments = sqliteTable(
  'letter_attachments',
  {
    id: id(),
    letterId: text('letter_id')
      .notNull()
      .references(() => letters.id, { onDelete: 'cascade' }),
    imageKey: text('image_key').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: ts('created_at')
      .notNull()
      .$defaultFn(() => Date.now())
  },
  (t) => [index('idx_letter_attachments_letter').on(t.letterId, t.sortOrder)]
)

export const letterPackagesRelations = relations(letterPackages, ({ one, many }) => ({
  prison: one(prisons, { fields: [letterPackages.prisonId], references: [prisons.id] }),
  purchases: many(letterPurchases)
}))

export const letterPurchasesRelations = relations(letterPurchases, ({ one }) => ({
  customer: one(customers, { fields: [letterPurchases.customerId], references: [customers.id] }),
  package: one(letterPackages, {
    fields: [letterPurchases.packageId],
    references: [letterPackages.id]
  }),
  prison: one(prisons, { fields: [letterPurchases.prisonId], references: [prisons.id] }),
  payment: one(payments, { fields: [letterPurchases.paymentId], references: [payments.id] })
}))

export const letterCreditLedgerRelations = relations(letterCreditLedger, ({ one }) => ({
  customer: one(customers, {
    fields: [letterCreditLedger.customerId],
    references: [customers.id]
  }),
  inmate: one(inmates, { fields: [letterCreditLedger.inmateId], references: [inmates.id] })
}))

export const lettersRelations = relations(letters, ({ one, many }) => ({
  senderCustomer: one(customers, {
    fields: [letters.senderCustomerId],
    references: [customers.id]
  }),
  recipientInmate: one(inmates, {
    fields: [letters.recipientInmateId],
    references: [inmates.id]
  }),
  prison: one(prisons, { fields: [letters.prisonId], references: [prisons.id] }),
  batch: one(letterBatches, { fields: [letters.batchId], references: [letterBatches.id] }),
  attachments: many(letterAttachments)
}))

export const letterBatchesRelations = relations(letterBatches, ({ one, many }) => ({
  prison: one(prisons, { fields: [letterBatches.prisonId], references: [prisons.id] }),
  zone: one(zones, { fields: [letterBatches.zoneId], references: [zones.id] }),
  letters: many(letters)
}))

export const letterAttachmentsRelations = relations(letterAttachments, ({ one }) => ({
  letter: one(letters, { fields: [letterAttachments.letterId], references: [letters.id] })
}))
