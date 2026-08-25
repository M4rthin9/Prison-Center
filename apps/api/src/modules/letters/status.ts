import { eq } from 'drizzle-orm'
import { db as defaultDb, type Db } from '../../db/client.js'
import { letterPurchases, type LetterPurchaseStatus } from '../../db/schema/index.js'
import { writeAudit } from '../../lib/audit.js'
import { moveCredits, releaseHeldReplies } from './credits.js'

/**
 * The letter purchase's half of a payment event. Like `deposits/status.ts`,
 * this module imports nothing from `modules/payments` — the spine calls in,
 * never the other way round.
 */

function purchase(purchaseId: string, database: Db) {
  return database.select().from(letterPurchases).where(eq(letterPurchases.id, purchaseId)).get()
}

function audit(
  row: NonNullable<ReturnType<typeof purchase>>,
  action: string,
  staffId: string | null,
  after: unknown,
  database: Db
) {
  writeAudit(
    {
      actorType: staffId ? 'staff' : 'system',
      actorId: staffId,
      action,
      entity: 'letter_purchase',
      entityId: row.id,
      prisonId: row.prisonId,
      before: { status: row.status },
      after
    },
    database
  )
}

/** A slip is on its way to staff. Nothing is granted until it passes. */
export function onLetterPurchaseSlipUploaded(
  purchaseId: string,
  at: number,
  database: Db = defaultDb()
) {
  const row = purchase(purchaseId, database)
  if (!row) return
  database
    .update(letterPurchases)
    .set({ status: 'pending' satisfies LetterPurchaseStatus, updatedAt: at })
    .where(eq(letterPurchases.id, purchaseId))
    .run()
  audit(row, 'letter_purchase.slip_uploaded', null, { status: 'pending' }, database)
}

/**
 * The money is real, so the coupons are real. Granting and marking paid happen
 * in one transaction, and any reply that was held waiting for a `to_home`
 * coupon is released in the same breath.
 */
export function onLetterPurchasePaymentVerified(
  purchaseId: string,
  at: number,
  staffId: string,
  database: Db = defaultDb()
) {
  const row = purchase(purchaseId, database)
  if (!row) return
  if (row.status === 'paid') return // idempotent: never grant a quota twice

  database.transaction(
    (tx) => {
      moveCredits(
        {
          customerId: row.customerId,
          direction: row.direction,
          delta: row.quota,
          reason: 'purchase',
          refType: 'letter_purchase',
          refId: row.id,
          prisonId: row.prisonId,
          note: row.packageNameSnapshot,
          createdBy: staffId
        },
        tx,
        at
      )
      tx.update(letterPurchases)
        .set({
          status: 'paid' satisfies LetterPurchaseStatus,
          paidAt: at,
          updatedBy: staffId,
          updatedAt: at
        })
        .where(eq(letterPurchases.id, purchaseId))
        .run()
    },
    { behavior: 'immediate' }
  )

  audit(row, 'letter_purchase.paid', staffId, { status: 'paid', quota: row.quota }, database)

  if (row.direction === 'to_home') {
    const released = releaseHeldReplies(row.customerId, { staffId }, database)
    if (released.length > 0) {
      audit(row, 'letter.replies_released', staffId, { released }, database)
    }
  }
}

/** A bad slip leaves the purchase unpaid and grants nothing. */
export function onLetterPurchasePaymentRejected(
  purchaseId: string,
  at: number,
  staffId: string,
  reason: string,
  database: Db = defaultDb()
) {
  const row = purchase(purchaseId, database)
  if (!row) return
  database
    .update(letterPurchases)
    .set({ status: 'pending' satisfies LetterPurchaseStatus, updatedBy: staffId, updatedAt: at })
    .where(eq(letterPurchases.id, purchaseId))
    .run()
  audit(row, 'letter_purchase.payment_rejected', staffId, { status: 'pending', reason }, database)
}

/**
 * Money went back out, so the coupons come back out too — even if that drives
 * the balance negative because they have already been spent. The ledger records
 * what happened; it does not pretend.
 */
export function onLetterPurchasePaymentRefunded(
  purchaseId: string,
  at: number,
  staffId: string,
  reason: string,
  database: Db = defaultDb()
) {
  const row = purchase(purchaseId, database)
  if (!row) return

  database.transaction(
    (tx) => {
      if (row.status === 'paid') {
        moveCredits(
          {
            customerId: row.customerId,
            direction: row.direction,
            delta: -row.quota,
            reason: 'refund',
            refType: 'letter_purchase',
            refId: row.id,
            prisonId: row.prisonId,
            note: reason,
            createdBy: staffId
          },
          tx,
          at
        )
      }
      tx.update(letterPurchases)
        .set({
          status: 'refunded' satisfies LetterPurchaseStatus,
          updatedBy: staffId,
          updatedAt: at
        })
        .where(eq(letterPurchases.id, purchaseId))
        .run()
    },
    { behavior: 'immediate' }
  )

  audit(row, 'letter_purchase.refunded', staffId, { status: 'refunded', reason }, database)
}
