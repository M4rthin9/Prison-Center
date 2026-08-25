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
