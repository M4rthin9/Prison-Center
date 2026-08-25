import { eq } from 'drizzle-orm'
import { db as defaultDb, type Db } from '../../db/client.js'
import { deposits, type DepositStatus } from '../../db/schema/index.js'
import { writeAudit } from '../../lib/audit.js'

/**
 * The deposit's half of a payment event. This module deliberately imports
 * nothing from `modules/payments` — the payment spine calls in, never the other
 * way round, which is what keeps `payments` ignorant of what it is paying for.
 */

function set(
  depositId: string,
  patch: Partial<typeof deposits.$inferInsert>,
  action: string,
  staffId: string | null,
  database: Db
) {
  const before = database.select().from(deposits).where(eq(deposits.id, depositId)).get()
  if (!before) return
  database.update(deposits).set(patch).where(eq(deposits.id, depositId)).run()
  writeAudit(
    {
      actorType: staffId ? 'staff' : 'system',
      actorId: staffId,
      action,
      entity: 'deposit',
      entityId: depositId,
      prisonId: before.prisonId,
      before: { status: before.status },
      after: patch
    },
    database
  )
}

/** The relative has sent a slip. The deposit is still `pending` — nothing has
 *  been received until a staff member says the slip is real. */
export function onDepositSlipUploaded(depositId: string, at: number, database: Db = defaultDb()) {
  set(
    depositId,
    { status: 'pending' satisfies DepositStatus, rejectReason: null, updatedAt: at },
    'deposit.slip_uploaded',
    null,
    database
  )
}

/**
 * The slip passed. The money is at the facility (`deposited_at`), but it is not
 * in the inmate's account until someone credits it — so the deposit moves to
 * `reviewing`, not `completed` (p.7).
 */
export function onDepositPaymentVerified(
  depositId: string,
  at: number,
  staffId: string,
  database: Db = defaultDb()
) {
  set(
    depositId,
    {
      status: 'reviewing' satisfies DepositStatus,
      depositedAt: at,
      rejectReason: null,
      updatedBy: staffId,
      updatedAt: at
    },
    'deposit.payment_verified',
    staffId,
    database
  )
}

/** A bad slip returns the deposit to `pending` so the relative can try again. */
export function onDepositPaymentRejected(
  depositId: string,
  at: number,
  staffId: string,
  reason: string,
  database: Db = defaultDb()
) {
  set(
    depositId,
    {
      status: 'pending' satisfies DepositStatus,
      depositedAt: null,
      rejectReason: reason,
      updatedBy: staffId,
      updatedAt: at
    },
    'deposit.payment_rejected',
    staffId,
    database
  )
}

/** Money went back out. The deposit is closed as rejected, never deleted. */
export function onDepositPaymentRefunded(
  depositId: string,
  at: number,
  staffId: string,
  reason: string,
  database: Db = defaultDb()
) {
  set(
    depositId,
    {
      status: 'rejected' satisfies DepositStatus,
      rejectReason: reason,
      reviewedBy: staffId,
      reviewedAt: at,
      updatedBy: staffId,
      updatedAt: at
    },
    'deposit.payment_refunded',
    staffId,
    database
  )
}
