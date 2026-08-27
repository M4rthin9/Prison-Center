import { normalizeThaiPhone } from '@pc/contract'
import { db as defaultDb, type Db } from '../../db/client.js'
import { writeAudit } from '../../lib/audit.js'
import { customerRealm, type RequestContext } from '../../lib/auth/index.js'
import { badRequest } from '../../lib/errors.js'
import { notify } from '../../lib/notify/index.js'
import { issueResetChallenge, verifyResetChallenge, type IssuedChallenge } from '../../lib/otp.js'
import { hashPassword } from '../../lib/password.js'
import { now } from '../../lib/time.js'
import { hit, OTP_IP_POLICY, OTP_TARGET_POLICY, OTP_VERIFY_POLICY } from '../../middleware/rate-limit.js'
import { getSetting } from '../settings/service.js'

/**
 * Self-service reset, Phase 7. The staff-assisted path from Phase 1 stays: it
 * is the fallback for a relative whose phone number changed, which is exactly
 * the case an OTP cannot help with.
 */
export async function requestPasswordReset(
  input: { phone: string },
  ctx: RequestContext & { db?: Db } = {}
): Promise<IssuedChallenge> {
  const db = ctx.db ?? defaultDb()
  if (!getSetting('features.self_service_reset', { db })) {
    throw badRequest('ยังไม่เปิดให้ตั้งรหัสผ่านใหม่ด้วยตนเอง กรุณาติดต่อเจ้าหน้าที่เรือนจำ')
  }

  const phone = normalizeThaiPhone(input.phone)
  if (!phone) throw badRequest('เบอร์มือถือไม่ถูกต้อง', { phone: ['เบอร์มือถือไม่ถูกต้อง'] })

  // Two throttles, both required: per-IP stops a sweep of the phone-number
  // space, per-number stops one relative's phone being flooded with SMS.
  hit(`otp:req:ip:${ctx.ip ?? 'unknown'}`, OTP_IP_POLICY, db)
  hit(`otp:req:target:${phone}`, OTP_TARGET_POLICY, db)

  const challenge = await issueResetChallenge({ target: phone, ip: ctx.ip ?? null, db })

  writeAudit(
    {
      actorType: 'customer',
      actorId: null,
      actorLabel: phone,
      action: 'auth.reset_requested',
      entity: 'customer',
      entityId: null,
      after: { reference: challenge.reference, channel: challenge.channel },
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null
    },
    db
  )
  return challenge
}

export async function completePasswordReset(
  input: { reference: string; code: string; password: string },
  ctx: RequestContext & { db?: Db } = {}
): Promise<void> {
  const db = ctx.db ?? defaultDb()
  hit(`otp:verify:ip:${ctx.ip ?? 'unknown'}`, OTP_VERIFY_POLICY, db)

  const { customerId, target } = verifyResetChallenge({
    reference: input.reference,
    code: input.code,
    db
  })

  const at = now()
  const hash = await hashPassword(input.password)
  // `mustChange` is false: the relative just chose this password themselves.
  customerRealm.setPassword(db, customerId, hash, false, at)
  // Whoever was holding a session on this account no longer is — that is the
  // entire point of a reset the account owner did not initiate.
  customerRealm.revokeAllForUser(db, customerId, at)

  writeAudit(
    {
      actorType: 'customer',
      actorId: customerId,
      actorLabel: target,
      action: 'auth.reset_completed',
      entity: 'customer',
      entityId: customerId,
      after: { reference: input.reference },
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null
    },
    db
  )

  await notify({
    audience: 'customer',
    recipientId: customerId,
    kind: 'account.password_reset',
    title: 'ตั้งรหัสผ่านใหม่แล้ว',
    body: 'หากไม่ใช่ท่านที่ดำเนินการ กรุณาติดต่อเจ้าหน้าที่เรือนจำทันที'
  })
}
