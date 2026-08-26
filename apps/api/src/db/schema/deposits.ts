import { relations } from 'drizzle-orm'
import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { id, satang, timestamps, ts } from './_shared.js'
import { inmates, prisons, zones } from './facility.js'
import { customers } from './people.js'
import { payments } from './payments.js'

/**
 * §4.4 / p.13: `ลงทะเบียนทำบัตรฝากเงิน` and `ยืนยันการฝากเงิน` are two distinct
 * flows. The card is a one-time approval per (relative, inmate); deposits are
 * per transaction and reuse the Phase 2 payment spine unchanged.
 */
export type DepositCardStatus = 'pending' | 'approved' | 'rejected' | 'suspended'

/** p.7: อัปเดตสถานะ → กำลังตรวจสอบ → เสร็จสิ้น. */
export type DepositStatus = 'pending' | 'reviewing' | 'completed' | 'rejected' | 'cancelled'

export const depositCards = sqliteTable(
  'deposit_cards',
  {
    id: id(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    inmateId: text('inmate_id')
      .notNull()
      .references(() => inmates.id, { onDelete: 'restrict' }),
    /** Snapshotted so the review queue stays scoped after a zone transfer. */
    prisonId: text('prison_id')
      .notNull()
      .references(() => prisons.id, { onDelete: 'restrict' }),
    /** `{PRISON_CODE}-C{YYMM}-{SEQ}`, allocated when a staff member approves. */
    cardNo: text('card_no'),
    status: text('status').$type<DepositCardStatus>().notNull().default('pending'),
    note: text('note'),
    approvedBy: text('approved_by'),
    approvedAt: ts('approved_at'),
    rejectReason: text('reject_reason'),
    ...timestamps()
  },
  (t) => [
    uniqueIndex('uq_deposit_cards_pair').on(t.customerId, t.inmateId),
    uniqueIndex('uq_deposit_cards_no').on(t.cardNo),
    index('idx_deposit_cards_review').on(t.prisonId, t.status, t.createdAt)
  ]
)

export const deposits = sqliteTable(
  'deposits',
  {
    id: id(),
    /** `{PRISON_CODE}-D{YYMM}-{SEQ}` — never mistakable for an order number. */
    depositNo: text('deposit_no').notNull(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    inmateId: text('inmate_id')
      .notNull()
      .references(() => inmates.id, { onDelete: 'restrict' }),
    cardId: text('card_id').references(() => depositCards.id, { onDelete: 'set null' }),
    prisonId: text('prison_id')
      .notNull()
      .references(() => prisons.id, { onDelete: 'restrict' }),
    /**
     * Snapshot of the inmate's แดน at deposit time. A zone transfer must not
     * rewrite last month's deposit report (§4.1).
     */
    zoneId: text('zone_id').references(() => zones.id, { onDelete: 'set null' }),
    zoneNameSnapshot: text('zone_name_snapshot'),
    inmateCodeSnapshot: text('inmate_code_snapshot').notNull(),
    inmateNameSnapshot: text('inmate_name_snapshot').notNull(),

    /** Who the money is *from* — not always the account holder (p.7). */
    depositorName: text('depositor_name').notNull(),
    amountSatang: satang('amount_satang').notNull(),
    /** The live payment. Rejected attempts stay in `payments`, not here. */
    paymentId: text('payment_id').references(() => payments.id, { onDelete: 'set null' }),

    status: text('status').$type<DepositStatus>().notNull().default('pending'),
    note: text('note'),
    reviewedBy: text('reviewed_by'),
    reviewedAt: ts('reviewed_at'),
    rejectReason: text('reject_reason'),

    /** When the money reached the facility — set the moment the slip passes. */
    depositedAt: ts('deposited_at'),
    /** When it was credited to the inmate's account inside the prison. */
    completedAt: ts('completed_at'),
    ...timestamps(),
    updatedBy: text('updated_by')
  },
  (t) => [
    uniqueIndex('uq_deposits_deposit_no').on(t.depositNo),
    // The review queue reads exactly this (§5 index list).
    index('idx_deposits_review').on(t.prisonId, t.status, t.depositedAt),
    /** Department-wide report range scan (§7). */
    index('idx_deposits_created').on(t.createdAt),
    index('idx_deposits_customer').on(t.customerId, t.createdAt),
    index('idx_deposits_inmate').on(t.inmateId, t.createdAt),
    index('idx_deposits_payment').on(t.paymentId)
  ]
)

export const depositCardsRelations = relations(depositCards, ({ one, many }) => ({
  customer: one(customers, { fields: [depositCards.customerId], references: [customers.id] }),
  inmate: one(inmates, { fields: [depositCards.inmateId], references: [inmates.id] }),
  prison: one(prisons, { fields: [depositCards.prisonId], references: [prisons.id] }),
  deposits: many(deposits)
}))

export const depositsRelations = relations(deposits, ({ one }) => ({
  customer: one(customers, { fields: [deposits.customerId], references: [customers.id] }),
  inmate: one(inmates, { fields: [deposits.inmateId], references: [inmates.id] }),
  card: one(depositCards, { fields: [deposits.cardId], references: [depositCards.id] }),
  prison: one(prisons, { fields: [deposits.prisonId], references: [prisons.id] }),
  payment: one(payments, { fields: [deposits.paymentId], references: [payments.id] })
}))
