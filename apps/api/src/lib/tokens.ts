import { randomBytes } from 'node:crypto'
import { SignJWT, jwtVerify } from 'jose'
import { env } from '../env.js'
import { MINUTE } from './time.js'
import { sha256 } from './password.js'

export type Realm = 'customer' | 'staff'

export interface AccessClaims {
  sub: string
  realm: Realm
  /** Staff only. null == department-wide (super_admin). */
  prisonId?: string | null
  role?: string
  /** Session row id — lets a refresh rotation invalidate live access tokens by lookup. */
  sid: string
  mcp?: boolean
}

let key: Uint8Array | null = null
const secret = () => (key ??= new TextEncoder().encode(env().JWT_SECRET))

const ISSUER = 'prison-commerce'

export async function signAccessToken(
  claims: AccessClaims
): Promise<{ token: string; expiresIn: number }> {
  const ttlMin = env().ACCESS_TOKEN_TTL_MINUTES
  const token = await new SignJWT({ ...claims })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setAudience(claims.realm)
    .setSubject(claims.sub)
    .setIssuedAt()
    .setExpirationTime(`${ttlMin}m`)
    .sign(secret())
  return { token, expiresIn: (ttlMin * MINUTE) / 1000 }
}

export async function verifyAccessToken(token: string, realm: Realm): Promise<AccessClaims> {
  const { payload } = await jwtVerify(token, secret(), { issuer: ISSUER, audience: realm })
  return payload as unknown as AccessClaims
}

/**
 * Refresh tokens are opaque random bytes. Only the SHA-256 is stored, so a
 * database leak cannot be replayed against the API.
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const token = randomBytes(48).toString('base64url')
  return { token, hash: sha256(token) }
}

export const hashRefreshToken = sha256
