import type { Context } from 'hono'
import { deleteCookie, getCookie, setCookie } from 'hono/cookie'
import type { Db } from '../../db/client.js'
import { env } from '../../env.js'
import { unauthorized } from '../errors.js'
import { generateRefreshToken, hashRefreshToken, signAccessToken } from '../tokens.js'
import { DAY, now } from '../time.js'
import type { AuthUser, RealmSpec } from './realms.js'

export interface IssuedSession {
  accessToken: string
  expiresIn: number
  mustChangePassword: boolean
  /** Plaintext refresh token — goes into the httpOnly cookie and nowhere else. */
  refreshToken: string
  sessionId: string
}

export interface RequestContext {
  ip?: string | null
  userAgent?: string | null
}

/**
 * Both realms and both providers (password now, LINE in Phase 7) issue exactly
 * this session shape.
 */
export async function createSession(
  spec: RealmSpec,
  db: Db,
  user: AuthUser,
  ctx: RequestContext = {}
): Promise<IssuedSession> {
  const e = env()
  const at = now()
  const { token, hash } = generateRefreshToken()
  const sessionId = spec.createSession(db, {
    userId: user.id,
    tokenHash: hash,
    expiresAt: at + e.REFRESH_TOKEN_TTL_DAYS * DAY,
    ip: ctx.ip ?? null,
    userAgent: ctx.userAgent ?? null
  })

  const { token: accessToken, expiresIn } = await signAccessToken({
    sub: user.id,
    realm: spec.realm,
    sid: sessionId,
    ...(spec.realm === 'staff' ? { role: user.role, prisonId: user.prisonId ?? null } : {}),
    ...(user.mustChangePassword ? { mcp: true } : {})
  })

  return {
    accessToken,
    expiresIn,
    mustChangePassword: user.mustChangePassword,
    refreshToken: token,
    sessionId
  }
}

/**
 * Rotating refresh: the presented token is revoked and replaced on every use.
 * Presenting an already-revoked token means the cookie leaked and is being
 * replayed — kill every session that user has and make them log in again.
 */
export async function rotateSession(
  spec: RealmSpec,
  db: Db,
  presented: string,
  ctx: RequestContext = {}
): Promise<IssuedSession> {
  const at = now()
  const row = spec.findSessionByHash(db, hashRefreshToken(presented))
  if (!row) throw unauthorized('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่')

  if (row.revokedAt !== null) {
    spec.revokeAllForUser(db, row.userId, at)
    throw unauthorized('ตรวจพบการใช้เซสชันซ้ำ กรุณาเข้าสู่ระบบใหม่')
  }
  if (row.expiresAt <= at) throw unauthorized('เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่')

  const user = spec.getById(db, row.userId)
  if (!user || user.disabled) throw unauthorized('บัญชีนี้ถูกระงับการใช้งาน')

  const issued = await createSession(spec, db, user, ctx)
  spec.revokeSession(db, row.id, issued.sessionId, at)
  return issued
}

export function revokeSessionByToken(spec: RealmSpec, db: Db, presented: string | undefined) {
  if (!presented) return
  const row = spec.findSessionByHash(db, hashRefreshToken(presented))
  if (row && row.revokedAt === null) spec.revokeSession(db, row.id, null, now())
}

/* ── cookie plumbing ───────────────────────────────────────────────────── */

export function setRefreshCookie(c: Context, spec: RealmSpec, token: string) {
  const e = env()
  setCookie(c, spec.cookieName, token, {
    httpOnly: true,
    secure: e.COOKIE_SECURE,
    sameSite: 'Lax',
    path: spec.cookiePath,
    maxAge: e.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60,
    ...(e.COOKIE_DOMAIN ? { domain: e.COOKIE_DOMAIN } : {})
  })
}

export function readRefreshCookie(c: Context, spec: RealmSpec): string | undefined {
  return getCookie(c, spec.cookieName)
}

export function clearRefreshCookie(c: Context, spec: RealmSpec) {
  const e = env()
  deleteCookie(c, spec.cookieName, {
    path: spec.cookiePath,
    secure: e.COOKIE_SECURE,
    ...(e.COOKIE_DOMAIN ? { domain: e.COOKIE_DOMAIN } : {})
  })
}

export function requestContext(c: Context): RequestContext {
  return {
    ip:
      c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
      c.req.header('x-real-ip') ??
      null,
    userAgent: c.req.header('user-agent') ?? null
  }
}
