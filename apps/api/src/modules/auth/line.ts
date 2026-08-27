import { eq } from 'drizzle-orm'
import { db as defaultDb, type Db } from '../../db/client.js'
import { customers } from '../../db/schema/index.js'
import { writeAudit } from '../../lib/audit.js'
import {
  createSession,
  customerRealm,
  type IssuedSession,
  type RequestContext
} from '../../lib/auth/index.js'
import { AppError, badRequest, conflict, unauthorized } from '../../lib/errors.js'
import { verifyLineIdToken } from '../../lib/line/id-token.js'
import { lineIdTokenProvider } from '../../lib/line/provider.js'
import { notify } from '../../lib/notify/index.js'
import { now } from '../../lib/time.js'
import { getSetting } from '../settings/service.js'

export interface LineTokenInput {
  idToken: string
  nonce?: string | null
}

function assertEnabled(db: Db) {
  if (!getSetting('features.line_login', { db })) {
    throw badRequest('ยังไม่ได้เปิดใช้งานการเข้าสู่ระบบด้วย LINE')
  }
}

/**
 * LINE login. Same `SessionResponse`, same cookie, same rotation as the
 * password path — the only difference is which provider proved the identity.
 */
export async function lineLogin(
  input: LineTokenInput,
  ctx: RequestContext & { db?: Db } = {}
): Promise<IssuedSession> {
  const db = ctx.db ?? defaultDb()
  assertEnabled(db)

  const result = await lineIdTokenProvider.authenticate(db, input)

  if (!result.ok) {
    writeAudit(
      {
        actorType: 'customer',
        actorId: null,
        actorLabel: 'line',
        action: 'auth.line_login_failed',
        entity: 'customer',
        entityId: null,
        after: { reason: result.reason },
        ip: ctx.ip ?? null,
        userAgent: ctx.userAgent ?? null
      },
      db
    )
    if (result.reason === 'not_linked') {
      // 404 with its own code: the app's answer is "log in with your phone
      // once and link", not "your credentials are wrong".
      throw new AppError(
        'LINE_NOT_LINKED',
        'บัญชี LINE นี้ยังไม่ได้เชื่อมกับบัญชีในระบบ กรุณาเข้าสู่ระบบด้วยเบอร์มือถือแล้วเชื่อมบัญชี'
      )
    }
    if (result.reason === 'blocked') throw new AppError('FORBIDDEN', 'บัญชีนี้ถูกระงับการใช้งาน')
    throw unauthorized('เข้าสู่ระบบด้วย LINE ไม่สำเร็จ')
  }

  const session = await createSession(customerRealm, db, result.user, ctx)
  writeAudit(
    {
      actorType: 'customer',
      actorId: result.userId,
      actorLabel: result.user.username,
      action: 'auth.line_login',
      entity: 'customer',
      entityId: result.userId,
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null
    },
    db
  )
  return session
}

export interface LineLinkState {
  lineLinked: boolean
  lineDisplayName: string | null
  linePictureUrl: string | null
  lineLinkedAt: number | null
}

/**
 * Linking is a single UPDATE onto the row the relative is already signed in
 * as — never an INSERT. The unique index on `line_user_id` is what makes the
 * "one LINE account, one system account" rule the database's job rather than
 * this function's.
 */
export async function linkLineAccount(
  customerId: string,
  input: LineTokenInput,
  ctx: RequestContext & { db?: Db } = {}
): Promise<LineLinkState> {
  const db = ctx.db ?? defaultDb()
  assertEnabled(db)

  const identity = await verifyLineIdToken(input.idToken, { nonce: input.nonce })
  const me = db.select().from(customers).where(eq(customers.id, customerId)).get()
  if (!me) throw unauthorized()

  const holder = db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.lineUserId, identity.sub))
    .get()
  if (holder && holder.id !== customerId) {
    throw conflict('บัญชี LINE นี้ถูกเชื่อมกับผู้ใช้รายอื่นแล้ว')
  }
  if (me.lineUserId && me.lineUserId !== identity.sub) {
    throw conflict('บัญชีนี้เชื่อมกับ LINE อื่นอยู่แล้ว กรุณายกเลิกการเชื่อมก่อน')
  }

  const at = now()
  const row = db
    .update(customers)
    .set({
      lineUserId: identity.sub,
      lineDisplayName: identity.name,
      linePictureUrl: identity.picture,
      lineLinkedAt: me.lineLinkedAt ?? at
    })
    .where(eq(customers.id, customerId))
    .returning()
    .get()

  writeAudit(
    {
      actorType: 'customer',
      actorId: customerId,
      actorLabel: me.username,
      action: 'auth.line_link',
      entity: 'customer',
      entityId: customerId,
      // The `sub` is a pseudonymous identifier, but it is still personal data:
      // record that a link happened, not which LINE account it points at.
      after: { lineLinked: true, displayName: identity.name },
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null
    },
    db
  )

  await notify({
    audience: 'customer',
    recipientId: customerId,
    kind: 'account.link_verified',
    title: 'เชื่อมบัญชี LINE สำเร็จ',
    body: 'ต่อจากนี้ระบบจะแจ้งเตือนคำสั่งซื้อ การชำระเงิน และการเยี่ยมผ่าน LINE'
  })

  return toState(row)
}

export function unlinkLineAccount(
  customerId: string,
  ctx: RequestContext & { db?: Db } = {}
): LineLinkState {
  const db = ctx.db ?? defaultDb()
  const me = db.select().from(customers).where(eq(customers.id, customerId)).get()
  if (!me) throw unauthorized()
  if (!me.lineUserId) throw badRequest('บัญชีนี้ยังไม่ได้เชื่อมกับ LINE')

  const row = db
    .update(customers)
    .set({ lineUserId: null, lineDisplayName: null, linePictureUrl: null, lineLinkedAt: null })
    .where(eq(customers.id, customerId))
    .returning()
    .get()

  writeAudit(
    {
      actorType: 'customer',
      actorId: customerId,
      actorLabel: me.username,
      action: 'auth.line_unlink',
      entity: 'customer',
      entityId: customerId,
      before: { lineLinked: true },
      after: { lineLinked: false },
      ip: ctx.ip ?? null,
      userAgent: ctx.userAgent ?? null
    },
    db
  )
  return toState(row)
}

const toState = (r: typeof customers.$inferSelect): LineLinkState => ({
  lineLinked: r.lineUserId !== null,
  lineDisplayName: r.lineDisplayName,
  linePictureUrl: r.linePictureUrl,
  lineLinkedAt: r.lineLinkedAt
})
