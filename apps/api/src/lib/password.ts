import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { hash, verify } from '@node-rs/argon2'

/**
 * OWASP Argon2id baseline. Not bcrypt: it truncates at 72 bytes and has no
 * memory hardness.
 *
 * Implementation note: the plan names the `argon2` package; this uses
 * `@node-rs/argon2`, which is the same algorithm and parameters with prebuilt
 * binaries for every target we ship to (no node-gyp on Windows dev machines).
 * Both realms go through this module, so swapping it is a one-file change.
 */
/** `Algorithm.Argon2id` — inlined because the export is a `const enum`. */
const ARGON2ID = 2

const PARAMS = {
  algorithm: ARGON2ID,
  memoryCost: 19456, // KiB — 19 MiB
  timeCost: 2,
  parallelism: 1
} as const

export function hashPassword(plain: string): Promise<string> {
  return hash(plain, PARAMS)
}

export async function verifyPassword(digest: string, plain: string): Promise<boolean> {
  try {
    return await verify(digest, plain, PARAMS)
  } catch {
    // Malformed hash in the row — treat as a failed login, never as a crash.
    return false
  }
}

/**
 * A login for a username that does not exist must cost the same as a wrong
 * password, or the timing difference enumerates accounts. The decoy hash is
 * computed once with the real parameters.
 */
let decoy: Promise<string> | null = null
export async function burnPasswordTime(plain = 'not-a-real-password'): Promise<void> {
  decoy ??= hashPassword(randomBytes(24).toString('base64url'))
  await verifyPassword(await decoy, plain)
}

/** Staff-assigned one-time passwords: readable aloud over a phone, still 40+ bits. */
const OTP_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
export function generateOneTimePassword(length = 10): string {
  const bytes = randomBytes(length)
  let out = ''
  for (let i = 0; i < length; i++) out += OTP_ALPHABET[bytes[i]! % OTP_ALPHABET.length]
  return out
}

export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex')

export function safeEqualHex(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'hex')
  const bb = Buffer.from(b, 'hex')
  return ba.length === bb.length && timingSafeEqual(ba, bb)
}
