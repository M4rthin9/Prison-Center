import { and, eq, inArray } from 'drizzle-orm'
import type { DbOrTx } from '../../db/client.js'
import { payments } from '../../db/schema/index.js'
import { conflict } from '../errors.js'

/**
 * Amount salting (§4.3). tag-29 carries no reference fields, so two relatives
 * paying ฿470 in the same minute are indistinguishable on a bank statement.
 * Charging ฿470.37 turns the amount itself into a short-lived reference.
 *
 * The invariant is stronger than "the salt is unique": the **charged amount**
 * must be unique among the channel's live payments. Two different order totals
 * may safely share a salt, which is what keeps a busy channel from running out
 * of the 99 available values.
 */

/** Payments that could still be settled by an incoming transfer. */
export const LIVE_STATES = ['pending', 'awaiting_verify'] as const

export const SALT_MIN = 1
export const SALT_MAX = 99

/**
 * Must be called inside the same transaction as the payment insert — the
 * uniqueness it establishes is only true for as long as nothing else writes.
 */
export function allocateSalt(
  channelId: string,
  amountSatang: number,
  db: DbOrTx,
  random: () => number = Math.random
): number {
  const taken = new Set(
    db
      .select({ charge: payments.chargeSatang })
      .from(payments)
      .where(and(eq(payments.channelId, channelId), inArray(payments.status, [...LIVE_STATES])))
      .all()
      .map((r) => r.charge)
  )

  // Random rather than sequential: a predictable satang value leaks how many
  // payments the facility has taken today.
  const start = SALT_MIN + Math.floor(random() * (SALT_MAX - SALT_MIN + 1))
  for (let i = 0; i < SALT_MAX; i++) {
    const salt = SALT_MIN + ((start - SALT_MIN + i) % SALT_MAX)
    if (!taken.has(amountSatang + salt)) return salt
  }

  // 99 live payments at this exact total on one channel. Refusing is correct:
  // an ambiguous amount is worse than a retry.
  throw conflict('ช่องทางชำระเงินนี้มีรายการรอชำระจำนวนมาก กรุณาลองใหม่ในอีกสักครู่')
}

/**
 * An unsalted charge still has to be unique for the same reason — this is the
 * check for channels that opt out of salting.
 */
export function chargeIsFree(channelId: string, chargeSatang: number, db: DbOrTx): boolean {
  const hit = db
    .select({ id: payments.id })
    .from(payments)
    .where(
      and(
        eq(payments.channelId, channelId),
        eq(payments.chargeSatang, chargeSatang),
        inArray(payments.status, [...LIVE_STATES])
      )
    )
    .get()
  return !hit
}
