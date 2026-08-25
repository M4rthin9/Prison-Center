import { relations } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { bool, id, jsonText, satang, timestamps, ts } from './_shared.js'
import { prisons } from './facility.js'
import { customers } from './people.js'

/**
 * Decision #4: the rail is configuration, not code. A facility may run more
 * than one at a time and the customer picks at checkout.
 *
 * - `promptpay_bill_payment`   EMVCo tag-30 — Biller ID + Ref1/Ref2 travel in
 *                              the payload, so reconciliation is exact.
 * - `promptpay_credit_transfer` EMVCo tag-29 — no reference fields at all;
 *                              amount salting is what makes it reconcilable.
 * - `bank_transfer`            no QR, account shown as text, slip only.
 */
export type PaymentRail = 'promptpay_bill_payment' | 'promptpay_credit_transfer' | 'bank_transfer'

/** tag-29 proxy kinds. `bank_account` is only meaningful for `bank_transfer`. */
export type TargetType = 'mobile' | 'national_id' | 'ewallet_id' | 'bank_account'

export type PaymentPurpose = 'order' | 'deposit' | 'letter_package'

export type PaymentState =
  'pending' | 'awaiting_verify' | 'succeeded' | 'failed' | 'expired' | 'refunded'

export type VerifyMethod = 'manual' | 'api_lookup' | 'statement_match'

/** What Ref1/Ref2 are filled with on a tag-30 payload. */
export type RefMode = 'payment_no' | 'inmate_code' | 'customer_phone' | 'none'

export const paymentChannels = sqliteTable(
  'payment_channels',
  {
    id: id(),
    /** NULL = department-wide channel, available to every facility. */
    prisonId: text('prison_id').references(() => prisons.id, { onDelete: 'restrict' }),
    rail: text('rail').$type<PaymentRail>().notNull(),
    displayName: text('display_name').notNull(),
    /** Lower sorts first; the lowest active channel is the checkout default. */
    priority: integer('priority').notNull().default(100),
    isActive: bool('is_active', true),

    /* tag-30 only */
    billerId: text('biller_id'),
    terminalSuffix: text('terminal_suffix'),
    ref1Mode: text('ref1_mode').$type<RefMode>().notNull().default('payment_no'),
    ref2Mode: text('ref2_mode').$type<RefMode>().notNull().default('none'),

    /* tag-29 only */
    targetType: text('target_type').$type<TargetType>(),
    targetValue: text('target_value'),

    /* display + slip matching, every rail */
    bankCode: text('bank_code'),
    accountNo: text('account_no'),
    accountName: text('account_name'),

    supportsPurposesJson: jsonText<PaymentPurpose[]>('supports_purposes_json')
      .notNull()
      .$defaultFn(() => ['order']),
    /**
     * tag-29 has no reference fields, so the charged amount *is* the reference.
     * Meaningless on tag-30, where Ref1 already carries `payment_no`.
     */
    amountSaltEnabled: bool('amount_salt_enabled', false),
    ttlMinutes: integer('ttl_minutes').notNull().default(30),
    note: text('note'),
    ...timestamps(),
    createdBy: text('created_by'),
    updatedBy: text('updated_by')
  },
  (t) => [
    uniqueIndex('uq_payment_channels_name').on(t.prisonId, t.displayName),
    index('idx_payment_channels_prison').on(t.prisonId, t.isActive, t.priority)
  ]
)

/**
 * One spine for every purpose (§4.3). `purpose` + `purpose_id` point at the
 * order / deposit / letter package; nothing else in the row knows which it is.
 */
export const payments = sqliteTable(
  'payments',
  {
    id: id(),
    /** `{PRISON_CODE}-P{YYMM}-{SEQ}`. Also the tag-30 Ref1, dashes stripped. */
    paymentNo: text('payment_no').notNull(),
    purpose: text('purpose').$type<PaymentPurpose>().notNull(),
    purposeId: text('purpose_id').notNull(),

    channelId: text('channel_id')
      .notNull()
      .references(() => paymentChannels.id, { onDelete: 'restrict' }),
    /** Snapshotted: a channel edited next month must not rewrite this payment. */
    rail: text('rail').$type<PaymentRail>().notNull(),

    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    prisonId: text('prison_id')
      .notNull()
      .references(() => prisons.id, { onDelete: 'restrict' }),

    /** What the order is worth. Stays clean for reports. */
    amountSatang: satang('amount_satang').notNull(),
    /** 0–99, the tag-29 reconciliation salt. Released on settle or expire. */
    amountSaltSatang: satang('amount_salt_satang').notNull().default(0),
    /** amount + salt. **This** is what is in the QR and matched against the slip. */
    chargeSatang: satang('charge_satang').notNull(),

    status: text('status').$type<PaymentState>().notNull().default('pending'),

    qrPayload: text('qr_payload'),
    qrRef1: text('qr_ref1'),
    qrRef2: text('qr_ref2'),
    expiresAt: ts('expires_at'),

    slipImageKey: text('slip_image_key'),
    slipUploadedAt: ts('slip_uploaded_at'),

    /**
     * UNIQUE system-wide. One slip settles exactly one payment — this single
     * constraint is the whole anti-fraud mechanism (§4.3 rule 1).
     */
    transRef: text('trans_ref'),
    sendingBank: text('sending_bank'),
    receivingBank: text('receiving_bank'),
    transferAmountSatang: satang('transfer_amount_satang'),
    transferredAt: ts('transferred_at'),

    verifiedBy: text('verified_by'),
    verifiedAt: ts('verified_at'),
    verifyMethod: text('verify_method').$type<VerifyMethod>(),
    rejectReason: text('reject_reason'),

    settledAt: ts('settled_at'),
    ...timestamps()
  },
  (t) => [
    uniqueIndex('uq_payments_payment_no').on(t.paymentNo),
    uniqueIndex('uq_payments_trans_ref').on(t.transRef),
    index('idx_payments_purpose').on(t.purpose, t.purposeId),
    index('idx_payments_status').on(t.status, t.createdAt),
    index('idx_payments_prison_created').on(t.prisonId, t.createdAt),
    index('idx_payments_customer').on(t.customerId, t.createdAt),
    // The salt allocator scans exactly this: live payments on one channel.
    index('idx_payments_channel_live').on(t.channelId, t.status, t.chargeSatang),
    index('idx_payments_expiry').on(t.status, t.expiresAt)
  ]
)

export const paymentChannelsRelations = relations(paymentChannels, ({ one, many }) => ({
  prison: one(prisons, { fields: [paymentChannels.prisonId], references: [prisons.id] }),
  payments: many(payments)
}))

export const paymentsRelations = relations(payments, ({ one }) => ({
  channel: one(paymentChannels, {
    fields: [payments.channelId],
    references: [paymentChannels.id]
  }),
  customer: one(customers, { fields: [payments.customerId], references: [customers.id] }),
  prison: one(prisons, { fields: [payments.prisonId], references: [prisons.id] })
}))
