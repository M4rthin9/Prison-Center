import { createMiddleware } from 'hono/factory'
import { eq, lt } from 'drizzle-orm'
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

/** OTP costs real money to send and lands on someone's phone. Priced accordingly. */
export const OTP_IP_POLICY: LimitPolicy = { limit: 10, windowMs: 15 * MINUTE, blockMs: 30 * MINUTE }
export const OTP_TARGET_POLICY: LimitPolicy = {
  limit: 3,
  windowMs: 15 * MINUTE,
  blockMs: 30 * MINUTE
}
export const OTP_VERIFY_POLICY: LimitPolicy = {
  limit: 15,
  windowMs: 15 * MINUTE,
  blockMs: 15 * MINUTE
}
/** A valid ID token is cheap to replay; verifying one is not. */
export const LINE_POLICY: LimitPolicy = { limit: 30, windowMs: 15 * MINUTE, blockMs: 15 * MINUTE }
/** The floor under every mutating route — generous enough never to bite a human. */
export const GLOBAL_WRITE_POLICY: LimitPolicy = {
  limit: 240,
  windowMs: MINUTE,
  blockMs: 2 * MINUTE
}

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

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])

/**
 * Blanket per-IP ceiling on writes, mounted once for the whole API. Reads are
 * exempt on purpose: a relative refreshing an order list is not the threat,
 * and the reports and dashboards a staff member opens are all GETs.
 *
 * Routes that need a tighter budget (login, OTP) still declare their own —
 * this is the floor, not the policy.
 */
export const globalWriteLimit = createMiddleware<AppEnv>(async (c, next) => {
  if (!SAFE.has(c.req.method)) {
    hit(`write:ip:${clientIp(c.req.raw.headers)}`, GLOBAL_WRITE_POLICY)
  }
  await next()
})

/** Housekeeping — a counter whose window closed long ago is dead weight. */
export function purgeRateLimits(db: Db = defaultDb(), olderThanMs = 24 * 60 * MINUTE): number {
  return db
    .delete(rateLimits)
    .where(lt(rateLimits.windowStart, now() - olderThanMs))
    .run().changes
}
