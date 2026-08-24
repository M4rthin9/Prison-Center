import { createMiddleware } from 'hono/factory'
import { db } from '../db/client.js'
import { customerRealm, staffRealm } from '../lib/auth/realms.js'
import { AppError, forbidden, unauthorized } from '../lib/errors.js'
import { verifyAccessToken } from '../lib/tokens.js'
import type { AppEnv, StaffPrincipal } from '../types.js'
import type { StaffRole } from '../db/schema/index.js'

function bearer(header: string | undefined): string | null {
  if (!header) return null
  const [scheme, token] = header.split(' ')
  return scheme?.toLowerCase() === 'bearer' && token ? token : null
}

/**
 * Verifies the access JWT and re-reads the user row. The row read is not
 * optional: it is what makes "blocked" and "session revoked" take effect
 * before the 15-minute token expires.
 */
export const requireCustomer = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearer(c.req.header('authorization'))
  if (!token) throw unauthorized()

  let claims
  try {
    claims = await verifyAccessToken(token, 'customer')
  } catch {
    throw unauthorized('โทเคนไม่ถูกต้องหรือหมดอายุ')
  }

  const user = customerRealm.getById(db(), claims.sub)
  if (!user) throw unauthorized()
  if (user.disabled) throw forbidden('บัญชีนี้ถูกระงับการใช้งาน')

  c.set('customer', {
    kind: 'customer',
    id: user.id,
    sessionId: claims.sid,
    mustChangePassword: user.mustChangePassword
  })
  await next()
})

export const requireStaff = createMiddleware<AppEnv>(async (c, next) => {
  const token = bearer(c.req.header('authorization'))
  if (!token) throw unauthorized()

  let claims
  try {
    claims = await verifyAccessToken(token, 'staff')
  } catch {
    throw unauthorized('โทเคนไม่ถูกต้องหรือหมดอายุ')
  }

  const user = staffRealm.getById(db(), claims.sub)
  if (!user) throw unauthorized()
  if (user.disabled) throw forbidden('บัญชีนี้ถูกระงับการใช้งาน')

  c.set('staff', {
    kind: 'staff',
    id: user.id,
    sessionId: claims.sid,
    role: user.role as StaffRole,
    prisonId: user.prisonId ?? null,
    mustChangePassword: user.mustChangePassword
  })
  await next()
})

/**
 * A forced password change blocks every route except the change itself and
 * logout — otherwise a one-time password stays usable indefinitely.
 */
export const blockUntilPasswordChanged = createMiddleware<AppEnv>(async (c, next) => {
  const principal = c.get('customer') ?? c.get('staff')
  if (principal?.mustChangePassword) {
    throw new AppError('MUST_CHANGE_PASSWORD', 'ต้องเปลี่ยนรหัสผ่านก่อนใช้งาน')
  }
  await next()
})

export const requireRole = (...roles: StaffRole[]) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const staff = c.get('staff') as StaffPrincipal | undefined
    if (!staff) throw unauthorized()
    if (!roles.includes(staff.role)) throw forbidden('บทบาทของคุณไม่มีสิทธิ์ในส่วนนี้')
    await next()
  })
