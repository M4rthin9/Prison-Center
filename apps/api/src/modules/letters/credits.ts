import { and, desc, eq, isNotNull } from 'drizzle-orm'
import type { LetterCreditBalance, LetterCredits, LetterDirection } from '@pc/contract'
import { db as defaultDb, type Db, type DbOrTx } from '../../db/client.js'
import { letterCreditLedger, letters } from '../../db/schema/index.js'
import { now } from '../../lib/time.js'

/**
 * The credit ledger, on its own so that `status.ts` — which the payment spine
 * calls into — can grant and revoke coupons without importing the letter
 * service, which imports the payment spine. One direction of dependency, no
 * cycle.
 */

/* ── the credit ledger (§4.5) ──────────────────────────────────────────── */

/**
 * Balance is the newest `balance_after` for the pair — never a stored counter.
 * Reads through `DbOrTx` so the consuming transaction reads its own writes.
 */
export function creditBalance(
  customerId: string,
  direction: LetterDirection,
  db: DbOrTx = defaultDb()
): number {
  return (
    db
      .select({ balanceAfter: letterCreditLedger.balanceAfter })
      .from(letterCreditLedger)
      .where(
        and(
          eq(letterCreditLedger.customerId, customerId),
          eq(letterCreditLedger.direction, direction)
        )
      )
      .orderBy(desc(letterCreditLedger.createdAt), desc(letterCreditLedger.id))
      .limit(1)
      .get()?.balanceAfter ?? 0
  )
}

export interface LedgerMove {
  customerId: string
  direction: LetterDirection
  delta: number
  reason: 'purchase' | 'consume' | 'refund' | 'admin_adjust' | 'expiry'
  refType?: string | null
  refId?: string | null
  inmateId?: string | null
  prisonId?: string | null
  note?: string | null
  createdBy?: string | null
}

/**
 * Appends one movement and returns the new balance. Always call inside the
 * transaction that performs the thing being paid for — that pairing is the
 * entire reason this is a ledger.
 */
export function moveCredits(move: LedgerMove, tx: DbOrTx, at = now()): number {
  const balanceAfter = creditBalance(move.customerId, move.direction, tx) + move.delta
  tx.insert(letterCreditLedger)
    .values({
      customerId: move.customerId,
      inmateId: move.inmateId ?? null,
      prisonId: move.prisonId ?? null,
      direction: move.direction,
      delta: move.delta,
      balanceAfter,
      reason: move.reason,
      refType: move.refType ?? null,
      refId: move.refId ?? null,
      note: move.note ?? null,
      createdAt: at,
      createdBy: move.createdBy ?? null
    })
    .run()
  return balanceAfter
}

export function letterCredits(customerId: string, db: Db = defaultDb()): LetterCredits {
  const ledger = db
    .select({
      id: letterCreditLedger.id,
      direction: letterCreditLedger.direction,
      delta: letterCreditLedger.delta,
      balanceAfter: letterCreditLedger.balanceAfter,
      reason: letterCreditLedger.reason,
      refType: letterCreditLedger.refType,
      refId: letterCreditLedger.refId,
      note: letterCreditLedger.note,
      createdAt: letterCreditLedger.createdAt
    })
    .from(letterCreditLedger)
    .where(eq(letterCreditLedger.customerId, customerId))
    .orderBy(desc(letterCreditLedger.createdAt), desc(letterCreditLedger.id))
    .limit(30)
    .all()

  const balance: LetterCreditBalance = {
    toPrison: creditBalance(customerId, 'to_prison', db),
    toHome: creditBalance(customerId, 'to_home', db)
  }
  return { balance, ledger }
}

/**
 * Credits just landed: unlock any replies that were held waiting for them,
 * oldest first, one credit each. Called from the payment-verified hook.
 */
export function releaseHeldReplies(
  customerId: string,
  ctx: { staffId?: string | null } = {},
  database: Db = defaultDb()
): string[] {
  const at = now()
  return database.transaction(
    (tx) => {
      const held = tx
        .select()
        .from(letters)
        .where(
          and(
            eq(letters.recipientCustomerId, customerId),
            eq(letters.direction, 'to_home'),
            eq(letters.status, 'queued'),
            isNotNull(letters.scanImageKey)
          )
        )
        .orderBy(letters.createdAt, letters.id)
        .all()

      const released: string[] = []
      for (const row of held) {
        if (creditBalance(customerId, 'to_home', tx) < 1) break
        moveCredits(
          {
            customerId,
            direction: 'to_home',
            delta: -1,
            reason: 'consume',
            refType: 'letter',
            refId: row.id,
            inmateId: row.senderInmateId,
            prisonId: row.prisonId,
            createdBy: ctx.staffId ?? null
          },
          tx,
          at
        )
        tx.update(letters)
          .set({ status: 'delivered', deliveredAt: at, updatedAt: at })
          .where(eq(letters.id, row.id))
          .run()
        released.push(row.id)
      }
      return released
    },
    { behavior: 'immediate' }
  )
}
