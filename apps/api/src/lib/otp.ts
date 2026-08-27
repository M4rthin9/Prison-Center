import { randomBytes, randomInt } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { and, eq, lt } from 'drizzle-orm'
import { db as defaultDb, type Db } from '../db/client.js'
import { customers, otpChallenges, type OtpChannel } from '../db/schema/index.js'
import { env } from '../env.js'
import { badRequest } from './errors.js'
import { pushMessage, textMessage } from './line/client.js'
import { safeEqualHex, sha256 } from './password.js'
import { MINUTE, now } from './time.js'

export interface IssuedChallenge {
  /** Shown to the relative and echoed back on verify — binds the two calls. */
  reference: string
  channel: OtpChannel
  expiresIn: number
  /** Only ever populated when OTP_ECHO is on (never in production). */
  code?: string
}

const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'

function reference(): string {
  const bytes = randomBytes(8)
  let out = ''
  for (let i = 0; i < 8; i++) out += REF_ALPHABET[bytes[i]! % REF_ALPHABET.length]
  return out
}

/** Six digits, uniformly drawn. Read aloud over a phone, typed on a numpad. */
const code = () => String(randomInt(0, 1_000_000)).padStart(6, '0')

/**
 * Issues a password-reset challenge for a phone number.
 *
 * A challenge is created **whether or not the number belongs to an account**,
 * and the response is identical either way. Otherwise this endpoint becomes a
 * free directory of every relative registered with the department.
 */
export async function issueResetChallenge(input: {
  target: string
  ip?: string | null
  db?: Db
}): Promise<IssuedChallenge> {
  const e = env()
  const db = input.db ?? defaultDb()
  const at = now()

  const customer = db
    .select({ id: customers.id, fullName: customers.fullName, lineUserId: customers.lineUserId })
    .from(customers)
    .where(and(eq(customers.username, input.target), eq(customers.isBlocked, false)))
    .get()

  // A relative who linked LINE gets the code in the chat they already trust;
  // everyone else gets an SMS. `console` is the dev/test adapter.
  const channel: OtpChannel =
    e.OTP_ADAPTER === 'console'
      ? 'console'
      : e.OTP_ADAPTER === 'line' && customer?.lineUserId
        ? 'line'
        : 'sms'

  const plain = code()
  const ref = reference()
  db.insert(otpChallenges)
    .values({
      purpose: 'password_reset',
      target: input.target,
      reference: ref,
      codeHash: sha256(`${ref}:${plain}`),
      channel,
      customerId: customer?.id ?? null,
      expiresAt: at + e.OTP_TTL_MINUTES * MINUTE,
      ip: input.ip ?? null
    })
    .run()

  if (customer) await deliver(channel, input.target, plain, ref, customer.lineUserId)

  return {
    reference: ref,
    channel,
    expiresIn: e.OTP_TTL_MINUTES * 60,
    ...(e.OTP_ECHO ? { code: plain } : {})
  }
}

const message = (plain: string, ref: string) =>
  `รหัสยืนยันสำหรับตั้งรหัสผ่านใหม่ของศูนย์บริการญาติผู้ต้องขังคือ ${plain} (อ้างอิง ${ref}) ` +
  `รหัสหมดอายุใน ${env().OTP_TTL_MINUTES} นาที เจ้าหน้าที่จะไม่ขอรหัสนี้จากท่าน`

async function deliver(
  channel: OtpChannel,
  target: string,
  plain: string,
  ref: string,
  lineUserId: string | null
): Promise<void> {
  const e = env()
  const text = message(plain, ref)

  // Delivery must never throw: a failed SMS gateway is a "did not arrive",
  // which the relative retries — not a 500 that leaks whether the number
  // belongs to an account.
  try {
    if (channel === 'line' && lineUserId) {
      await pushMessage(lineUserId, [textMessage(text)])
      return
    }
    if (channel === 'sms' && e.SMS_ENDPOINT) {
      const res = await fetch(e.SMS_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(e.SMS_API_KEY ? { Authorization: `Bearer ${e.SMS_API_KEY}` } : {})
        },
        body: JSON.stringify({ to: target, sender: e.SMS_SENDER, message: text })
      })
      if (!res.ok) console.error(`[otp] sms gateway → ${res.status}`)
      return
    }
    // console adapter — the code lands in the outbox a dev already reads.
    fs.mkdirSync(path.dirname(e.paths.outbox), { recursive: true })
    fs.appendFileSync(
      e.paths.outbox,
      JSON.stringify({ at: new Date().toISOString(), kind: 'otp.password_reset', target, text }) +
        '\n',
      'utf8'
    )
    console.log(`[otp] password reset for ${target}: ${plain} (ref ${ref})`)
  } catch (err) {
    console.error('[otp] delivery failed', err)
  }
}

export interface VerifiedChallenge {
  customerId: string
  target: string
}

/**
 * Consumes a challenge. Wrong codes are counted on the row itself, so the
 * attempt budget cannot be reset by asking for a new code — the old row keeps
 * its own count and the per-phone throttle limits how many rows can exist.
 */
export function verifyResetChallenge(input: {
  reference: string
  code: string
  db?: Db
}): VerifiedChallenge {
  const db = input.db ?? defaultDb()
  const at = now()
  const invalid = () => badRequest('รหัสยืนยันไม่ถูกต้องหรือหมดอายุ', { code: ['รหัสไม่ถูกต้อง'] })

  const row = db
    .select()
    .from(otpChallenges)
    .where(eq(otpChallenges.reference, input.reference.trim().toUpperCase()))
    .get()
  if (!row || row.consumedAt !== null || row.expiresAt <= at) throw invalid()
  if (row.attempts >= row.maxAttempts) throw invalid()

  if (!safeEqualHex(row.codeHash, sha256(`${row.reference}:${input.code.trim()}`))) {
    db.update(otpChallenges)
      .set({ attempts: row.attempts + 1 })
      .where(eq(otpChallenges.id, row.id))
      .run()
    throw invalid()
  }

  db.update(otpChallenges).set({ consumedAt: at }).where(eq(otpChallenges.id, row.id)).run()

  // A challenge issued for an unregistered number verifies fine and then has
  // nothing to reset — same shape, same timing, no account disclosure.
  if (!row.customerId) throw invalid()
  return { customerId: row.customerId, target: row.target }
}

/** Housekeeping: an expired challenge is not evidence of anything. */
export function purgeOtpChallenges(db: Db = defaultDb(), olderThanMs = 24 * 60 * MINUTE): number {
  return db
    .delete(otpChallenges)
    .where(lt(otpChallenges.expiresAt, now() - olderThanMs))
    .run().changes
}
