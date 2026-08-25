import { createMiddleware } from 'hono/factory'
import { eq } from 'drizzle-orm'
import { db as defaultDb, type Db } from '../db/client.js'
import { rateLimits } from '../db/schema/index.js'
import { rateLimited } from '../lib/errors.js'
import { MINUTE, now } from '../lib/time.js'
import type { AppEnv } from '../types.js'

export interface LimitPolicy {
  /** Requests allowed per window. */
  limit: number
  windowMs: number
  /** How long to block once the limit is exceeded. */
  blockMs: number
}

export const LOGIN_POLICY: LimitPolicy = { limit: 20, windowMs: 15 * MINUTE, blockMs: 15 * MINUTE }
export const WRITE_POLICY: LimitPolicy = { limit: 60, windowMs: MINUTE, blockMs: MINUTE }

/**
 * Counters live in SQLite, not memory: one writer process, so the table is
 * both accurate and survives a restart — and the block persists across the
 * `--watch` reloads that would otherwise reset an in-memory limiter.
 */
export function hit(key: string, policy: LimitPolicy, db: Db = defaultDb()): void {
  const at = now()
  const row = db.select().from(rateLimits).where(eq(rateLimits.key, key)).get()

  if (row?.blockedUntil && row.blockedUntil > at) {
    throw rateLimited('พยายามบ่อยเกินไป กรุณารอสักครู่', Math.ceil((row.blockedUntil - at) / 1000))
  }

  if (!row || at - row.windowStart > policy.windowMs) {
    db.insert(rateLimits)
      .values({ key, count: 1, windowStart: at, blockedUntil: null })
      .onConflictDoUpdate({
        target: rateLimits.key,
        set: { count: 1, windowStart: at, blockedUntil: null }
      })
      .run()
    return
  }

  const count = row.count + 1
  const blockedUntil = count > policy.limit ? at + policy.blockMs : null
  db.update(rateLimits).set({ count, blockedUntil }).where(eq(rateLimits.key, key)).run()

  if (blockedUntil) {
    throw rateLimited('พยายามบ่อยเกินไป กรุณารอสักครู่', Math.ceil(policy.blockMs / 1000))
  }
}

export function clientIp(headers: Headers | { get(name: string): string | null }): string {
  return (
    headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? headers.get('x-real-ip') ?? 'unknown'
  )
}

/** Per-IP throttle. Per-username counting lives in the auth provider's lockout. */
export const rateLimit = (bucket: string, policy: LimitPolicy = WRITE_POLICY) =>
  createMiddleware<AppEnv>(async (c, next) => {
    hit(`${bucket}:ip:${clientIp(c.req.raw.headers)}`, policy)
    await next()
  })
