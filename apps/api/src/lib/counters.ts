import { sql } from 'drizzle-orm'
import { db as defaultDb, type DbOrTx } from '../db/client.js'
import { counters } from '../db/schema/index.js'
import { bangkokMonth, now } from './time.js'

/**
 * Human-facing sequence numbers. One statement — insert-or-bump with
 * `RETURNING` — so the number is allocated inside whatever transaction the
 * caller is already in and two concurrent orders can never share one.
 *
 * `value + 1` is deliberately unqualified: inside an UPSERT `DO UPDATE SET`
 * that resolves to the conflicting row, which is exactly what we want here.
 */
export function nextSequence(scope: string, period: string, db: DbOrTx = defaultDb()): number {
  const row = db
    .insert(counters)
    .values({ scope, period, value: 1, updatedAt: now() })
    .onConflictDoUpdate({
      target: [counters.scope, counters.period],
      set: { value: sql`value + 1`, updatedAt: now() }
    })
    .returning({ value: counters.value })
    .get()
  return row.value
}

/** `{PRISON_CODE}-{YYMM}-{SEQ}` (§4.2), e.g. `KLP-2508-0001`. */
export function nextOrderNo(
  prisonId: string,
  prisonCode: string,
  db: DbOrTx = defaultDb(),
  at = now()
): string {
  const period = bangkokMonth(at).replace('-', '').slice(2) // 2025-08 → 2508
  const seq = nextSequence(`order:${prisonId}`, period, db)
  return `${prisonCode}-${period}-${String(seq).padStart(4, '0')}`
}

/**
 * `{PRISON_CODE}-P{YYMM}-{SEQ}` (§4.3), e.g. `KLP-P2508-0001`. The `P` keeps a
 * payment number from ever being mistaken for an order number in a bank
 * statement export, and the dash-stripped form (`KLPP25080001`, 12 chars) is
 * what goes into the tag-30 Ref1 field.
 */
export function nextPaymentNo(
  prisonId: string,
  prisonCode: string,
  db: DbOrTx = defaultDb(),
  at = now()
): string {
  const period = bangkokMonth(at).replace('-', '').slice(2)
  const seq = nextSequence(`payment:${prisonId}`, period, db)
  return `${prisonCode}-P${period}-${String(seq).padStart(4, '0')}`
}

/**
 * `{PRISON_CODE}-D{YYMM}-{SEQ}` (§4.4) — `KLP-D2508-0001`. Deposits get their
 * own letter for the same reason payments do: a number read aloud over the
 * phone to a relative must be unambiguous about which thing it identifies.
 */
export function nextDepositNo(
  prisonId: string,
  prisonCode: string,
  db: DbOrTx = defaultDb(),
  at = now()
): string {
  const period = bangkokMonth(at).replace('-', '').slice(2)
  const seq = nextSequence(`deposit:${prisonId}`, period, db)
  return `${prisonCode}-D${period}-${String(seq).padStart(4, '0')}`
}

/** `{PRISON_CODE}-C{YYMM}-{SEQ}` — the deposit card, allocated on approval. */
export function nextDepositCardNo(
  prisonId: string,
  prisonCode: string,
  db: DbOrTx = defaultDb(),
  at = now()
): string {
  const period = bangkokMonth(at).replace('-', '').slice(2)
  const seq = nextSequence(`deposit_card:${prisonId}`, period, db)
  return `${prisonCode}-C${period}-${String(seq).padStart(4, '0')}`
}

/** `{PRISON_CODE}-L{YYMM}-{SEQ}` (§4.5) — and this is what the reply QR encodes. */
export function nextLetterNo(
  prisonId: string,
  prisonCode: string,
  db: DbOrTx = defaultDb(),
  at = now()
): string {
  const period = bangkokMonth(at).replace('-', '').slice(2)
  const seq = nextSequence(`letter:${prisonId}`, period, db)
  return `${prisonCode}-L${period}-${String(seq).padStart(4, '0')}`
}

/** `{PRISON_CODE}-B{YYMM}-{SEQ}` — one print batch, one stack of paper. */
export function nextLetterBatchNo(
  prisonId: string,
  prisonCode: string,
  db: DbOrTx = defaultDb(),
  at = now()
): string {
  const period = bangkokMonth(at).replace('-', '').slice(2)
  const seq = nextSequence(`letter_batch:${prisonId}`, period, db)
  return `${prisonCode}-B${period}-${String(seq).padStart(4, '0')}`
}

/** `{PRISON_CODE}-M{YYMM}-{SEQ}` — M for mail: a letter package purchase. */
export function nextLetterPurchaseNo(
  prisonId: string,
  prisonCode: string,
  db: DbOrTx = defaultDb(),
  at = now()
): string {
  const period = bangkokMonth(at).replace('-', '').slice(2)
  const seq = nextSequence(`letter_purchase:${prisonId}`, period, db)
  return `${prisonCode}-M${period}-${String(seq).padStart(4, '0')}`
}
