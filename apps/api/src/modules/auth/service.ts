import { eq } from 'drizzle-orm'
import { normalizeThaiPhone } from '@pc/contract'
import { db as defaultDb, type Db } from '../../db/client.js'
import { customers } from '../../db/schema/index.js'
import { writeAudit } from '../../lib/audit.js'
import {
  createPasswordProvider,
  createSession,
  customerRealm,
  staffRealm,
  type AuthProvider,
  type IssuedSession,
  type RealmSpec,
  type RequestContext
} from '../../lib/auth/index.js'
import { AppError, badRequest, conflict, unauthorized } from '../../lib/errors.js'
import { hashPassword, verifyPassword } from '../../lib/password.js'
import { hit, LOGIN_POLICY } from '../../middleware/rate-limit.js'
import { now } from '../../lib/time.js'

export const customerPasswordProvider: AuthProvider = createPasswordProvider(customerRealm)
export const staffPasswordProvider: AuthProvider = createPasswordProvider(staffRealm)

export interface LoginInput {
  username: string
  password: string
}

/**
 * Failures are counted per-username *and* per-IP, and every one is audited.
 * The per-IP window is what stops a spray across many accounts from a single
 * host; the per-username lockout lives in the provider.
 */
export async function login(
  spec: RealmSpec,
  provider: AuthProvider,
  input: LoginInput,
  ctx: RequestContext & { db?: Db } = {}
): Promise<IssuedSession> {
  const db = ctx.db ?? defaultDb()
  const username =
    spec.realm === 'customer'
      ? (normalizeThaiPhone(input.username) ?? input.username)
      : input.username.trim()

  // Per-IP throttle stops a spray across many accounts from one host; the
  // per-username count is the account lockout inside the provider.
  hit(`login:${spec.realm}:ip:${ctx.ip ?? 'unknown'}`, LOGIN_POLICY, db)

  const result = await provider.authenticate(db, { username, password: input.password })

  if (!result.ok) {
    writeAudit(
      {
        actorType: spec.realm === 'staff' ? 'staff' : 'customer',
        actorId: null,
        actorLabel: username,
        action: 'auth.login_failed',
        entity: spec.realm,
        entityId: null,
        after: { reason: result.reason },
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null
      },
      db
    )

    if (result.reason === 'locked_out') {
      throw new AppError('LOCKED_OUT', 'บัญชีถูกล็อกชั่วคราวจากการเข้าสู่ระบบผิดหลายครั้ง', {
        headers: { 'Retry-After': String(result.retryAfterSec) }
      })
    }
    if (result.reason === 'blocked') throw new AppError('FORBIDDEN', 'บัญชีนี้ถูกระงับการใช้งาน')
    throw unauthorized('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง')
  }

  const session = await createSession(spec, db, result.user, ctx)
  writeAudit(
    {
      actorType: spec.realm === 'staff' ? 'staff' : 'customer',
      actorId: result.userId,
      actorLabel: username,
      action: 'auth.login',
      entity: spec.realm,
      entityId: result.userId,
      prisonId: result.user.prisonId ?? null,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null
    },
    db
  )
  return session
}

export interface RegisterInput {
  phone: string
  password: string
  fullName: string
}

/**
 * Open self-signup. The account can browse; ordering, deposits, letters and
 * visits stay locked behind a staff-verified `customer_inmates` link.
 */
export async function registerCustomer(
  input: RegisterInput,
  ctx: RequestContext & { db?: Db } = {}
): Promise<IssuedSession> {
  const db = ctx.db ?? defaultDb()
  const phone = normalizeThaiPhone(input.phone)
  if (!phone) throw badRequest('เบอร์มือถือไม่ถูกต้อง', { phone: ['เบอร์มือถือไม่ถูกต้อง'] })

  const existing = db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.username, phone))
    .get()
  if (existing) throw conflict('เบอร์มือถือนี้ลงทะเบียนแล้ว')

  const passwordHash = await hashPassword(input.password)
  const at = now()
  const row = db
    .insert(customers)
    .values({
      username: phone,
      phone,
      fullName: input.fullName.trim(),
      passwordHash,
      passwordChangedAt: at,
      mustChangePassword: false
    })
    .returning()
    .get()

  writeAudit(
    {
      actorType: 'customer',
      actorId: row.id,
      actorLabel: phone,
      action: 'auth.register',
      entity: 'customer',
      entityId: row.id,
      after: { username: phone, fullName: row.fullName },
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null
    },
    db
  )

  return createSession(customerRealm, db, customerRealm.getById(db, row.id)!, ctx)
}

export async function changePassword(
  spec: RealmSpec,
  userId: string,
  input: { current: string; next: string },
  ctx: RequestContext & { db?: Db } = {}
): Promise<IssuedSession> {
  const db = ctx.db ?? defaultDb()
  const user = spec.getById(db, userId)
  if (!user) throw unauthorized()

  const valid = await verifyPassword(user.passwordHash, input.current)
  if (!valid) throw badRequest('รหัสผ่านปัจจุบันไม่ถูกต้อง', { current: ['รหัสผ่านไม่ถูกต้อง'] })
  if (input.current === input.next) throw badRequest('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านเดิม')

  const hash = await hashPassword(input.next)
  const at = now()
  spec.setPassword(db, userId, hash, false, at)

  // Changing a password invalidates every other session that user holds.
  spec.revokeAllForUser(db, userId, at)

  writeAudit(
    {
      actorType: spec.realm === 'staff' ? 'staff' : 'customer',
      actorId: userId,
      actorLabel: user.username,
      action: 'auth.change_password',
      entity: spec.realm,
      entityId: userId,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null
    },
    db
  )

  return createSession(spec, db, { ...user, mustChangePassword: false }, ctx)
}
