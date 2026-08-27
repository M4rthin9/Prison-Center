import type { Db } from '../../db/client.js'
import { burnPasswordTime, verifyPassword } from '../password.js'
import { MINUTE, now } from '../time.js'
import type { AuthUser, RealmSpec } from './realms.js'

export type AuthFailure =
  | { ok: false; reason: 'invalid_credentials' }
  | { ok: false; reason: 'locked_out'; retryAfterSec: number }
  | { ok: false; reason: 'blocked' }
  /** LINE only: the token is valid but no account claims that `line_user_id`. */
  | { ok: false; reason: 'not_linked' }

export type AuthSuccess = { ok: true; userId: string; user: AuthUser }
export type AuthResult = AuthSuccess | AuthFailure

/**
 * The seam that keeps LINE login a Phase 7 addition rather than a rewrite
 * (§4.1b). Everything downstream of `createSession()` is provider-agnostic:
 * adding LINE means implementing `LineIdTokenProvider` here and writing
 * `line_user_id` onto the existing customer row — never creating a second one.
 */
export interface AuthProvider {
  readonly kind: 'password' | 'line'
  authenticate(db: Db, input: unknown): Promise<AuthResult>
}

/* ── lockout policy ────────────────────────────────────────────────────── */

const LOCK_THRESHOLD = 5
const BASE_LOCK_MS = 15 * MINUTE
const MAX_LOCK_MS = 24 * 60 * MINUTE

/** 5 failures → 15 min, doubling for each failure after that, capped at 24h. */
export function lockoutFor(failedAttempts: number): number | null {
  if (failedAttempts < LOCK_THRESHOLD) return null
  const steps = failedAttempts - LOCK_THRESHOLD
  return Math.min(BASE_LOCK_MS * 2 ** steps, MAX_LOCK_MS)
}

export interface PasswordInput {
  username: string
  password: string
}

export function createPasswordProvider(spec: RealmSpec): AuthProvider {
  return {
    kind: 'password',

    async authenticate(db, raw): Promise<AuthResult> {
      const input = raw as PasswordInput
      const user = spec.getByUsername(db, input.username)

      // Unknown username still pays the argon2 cost — otherwise the response
      // time enumerates accounts.
      if (!user) {
        await burnPasswordTime(input.password)
        return { ok: false, reason: 'invalid_credentials' }
      }

      const at = now()
      if (user.lockedUntil && user.lockedUntil > at) {
        return {
          ok: false,
          reason: 'locked_out',
          retryAfterSec: Math.ceil((user.lockedUntil - at) / 1000)
        }
      }
      if (user.disabled) {
        await burnPasswordTime(input.password)
        return { ok: false, reason: 'blocked' }
      }

      const valid = await verifyPassword(user.passwordHash, input.password)
      if (!valid) {
        // A lock that has expired starts the count over rather than resuming it.
        const attempts = (user.lockedUntil && user.lockedUntil <= at ? 0 : user.failedAttempts) + 1
        const lockMs = lockoutFor(attempts)
        spec.recordFailure(db, user.id, attempts, lockMs ? at + lockMs : null)
        return lockMs
          ? { ok: false, reason: 'locked_out', retryAfterSec: Math.ceil(lockMs / 1000) }
          : { ok: false, reason: 'invalid_credentials' }
      }

      spec.recordSuccess(db, user.id, at)
      return { ok: true, userId: user.id, user: { ...user, failedAttempts: 0, lockedUntil: null } }
    }
  }
}
