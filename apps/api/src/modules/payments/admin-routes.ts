import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq, gte, like, lte, or, sql } from 'drizzle-orm'
import {
  CreatePaymentChannelInput,
  PageQuery,
  PaymentChannel,
  PaymentDetail,
  PaymentPurpose,
  PaymentRail,
  PaymentState,
  PaymentSummary,
  RefundPaymentInput,
  RejectPaymentInput,
  Ulid,
  UpdatePaymentChannelInput,
  VerifyPaymentInput,
  pageOf
} from '@pc/contract'
import { db } from '../../db/client.js'
import { paymentChannels, payments } from '../../db/schema/index.js'
import { writeAudit } from '../../lib/audit.js'
import { conflict, forbidden, notFound } from '../../lib/errors.js'
import { decodeCursor, paginate } from '../../lib/cursor.js'
import { bearerAuth, commonErrors, jsonBody, jsonRes } from '../../lib/openapi.js'
import { defaultHook } from '../../lib/hook.js'
import { requestContext } from '../../lib/auth/session.js'
import { blockUntilPasswordChanged, requireRole, requireStaff } from '../../middleware/auth.js'
import {
  assertInScope,
  prisonScope,
  resolvePrisonId,
  scopeFilter
} from '../../middleware/prison-scope.js'
import type { AppEnv } from '../../types.js'
import {
  channelValues,
  depositNosFor,
  letterPurchaseNosFor,
  orderNosFor,
  paymentDetail,
  paymentSummaryQuery,
  readSlip,
  refundPayment,
  rejectPayment,
  toChannelAdmin,
  verifyPayment
} from './service.js'

/** Channels are where the money lands — catalog-grade write access. */
const canEditChannels = requireRole('super_admin', 'prison_admin')
/** Finance is the point of this screen; the two admins keep access for cover. */
const canVerify = requireRole('super_admin', 'prison_admin', 'finance')

export function createAdminPaymentRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireStaff)
  app.use('*', blockUntilPasswordChanged)

  /* ── channels ──────────────────────────────────────────────────────── */

  app.openapi(
    createRoute({
      method: 'get',
      path: '/payment-channels',
      tags: ['admin:payments'],
      summary: 'ช่องทางชำระเงินในขอบเขตของผู้ใช้',
      security: bearerAuth,
      request: {
        query: z.object({
          prisonId: Ulid.optional(),
          includeInactive: z.enum(['true', 'false']).optional()
        })
      },
      responses: {
        200: jsonRes(z.object({ items: z.array(PaymentChannel) }), 'ช่องทางชำระเงิน'),
        ...commonErrors
      }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const { prisonId, includeInactive } = c.req.valid('query')
      const requested = resolvePrisonId(scope, prisonId ?? null)

      const rows = db()
        .select()
        .from(paymentChannels)
        .where(
          and(
            requested
              ? // Department-wide channels are usable by this facility, so they
                // belong in its list even though they are not scoped to it.
                or(
                  eq(paymentChannels.prisonId, requested),
                  sql`${paymentChannels.prisonId} is null`
                )
              : scopeFilter(scope, paymentChannels.prisonId),
            includeInactive === 'true' ? undefined : eq(paymentChannels.isActive, true)
          )
        )
        .orderBy(paymentChannels.priority, paymentChannels.displayName)
        .all()

      return c.json({ items: rows.map((r) => toChannelAdmin(r, db())) }, 200)
    }
  )

  /** A department-wide channel serves every facility — super_admin only. */
  const assertChannelScope = (scope: ReturnType<typeof prisonScope>, prisonId: string | null) => {
    if (prisonId === null && scope.kind !== 'all') {
      throw forbidden('ช่องทางส่วนกลางแก้ไขได้เฉพาะผู้ดูแลระบบส่วนกลาง')
    }
    assertInScope(scope, prisonId)
  }

  app.openapi(
    createRoute({
      method: 'post',
      path: '/payment-channels',
      tags: ['admin:payments'],
      summary: 'เพิ่มช่องทางชำระเงิน',
      security: bearerAuth,
      middleware: [canEditChannels] as const,
      request: { body: jsonBody(CreatePaymentChannelInput) },
      responses: { 201: jsonRes(PaymentChannel, 'ช่องทางที่สร้างแล้ว'), ...commonErrors }
    }),
    (c) => {
      const staff = c.get('staff')!
      const scope = prisonScope(staff)
      const input = c.req.valid('json')
      const values = channelValues(input)
      // Non-super staff may not create a department-wide channel by omitting
      // prisonId — the scope decides, not the payload.
      if (scope.kind !== 'all') values.prisonId = scope.prisonId
      assertChannelScope(scope, values.prisonId)

      const exists = db()
        .select({ id: paymentChannels.id })
        .from(paymentChannels)
        .where(
          and(
            values.prisonId
              ? eq(paymentChannels.prisonId, values.prisonId)
              : sql`${paymentChannels.prisonId} is null`,
            eq(paymentChannels.displayName, values.displayName)
          )
        )
        .get()
      if (exists) throw conflict('มีช่องทางชื่อนี้อยู่แล้ว')

      const row = db()
        .insert(paymentChannels)
        .values({ ...values, createdBy: staff.id, updatedBy: staff.id })
        .returning()
        .get()

      const ctx = requestContext(c)
      writeAudit({
        actorType: 'staff',
        actorId: staff.id,
        action: 'payment_channel.created',
        entity: 'payment_channel',
        entityId: row.id,
        prisonId: row.prisonId,
        after: { rail: row.rail, displayName: row.displayName },
        ip: ctx.ip,
        userAgent: ctx.userAgent
      })
      return c.json(toChannelAdmin(row, db()), 201)
    }
  )

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/payment-channels/{id}',
      tags: ['admin:payments'],
      summary: 'แก้ไขช่องทางชำระเงิน',
      description: 'ส่งค่าทั้งชุด — ช่องทางที่แก้ไปครึ่งเดียวไม่ใช่ช่องทางที่ใช้ได้',
      security: bearerAuth,
      middleware: [canEditChannels] as const,
      request: { params: z.object({ id: Ulid }), body: jsonBody(UpdatePaymentChannelInput) },
      responses: { 200: jsonRes(PaymentChannel, 'ช่องทางที่แก้ไขแล้ว'), ...commonErrors }
    }),
    (c) => {
      const staff = c.get('staff')!
      const scope = prisonScope(staff)
      const { id } = c.req.valid('param')

      const before = db().select().from(paymentChannels).where(eq(paymentChannels.id, id)).get()
      if (!before) throw notFound('ไม่พบช่องทางชำระเงิน')
      assertChannelScope(scope, before.prisonId)

      const values = channelValues(c.req.valid('json'))
      if (scope.kind !== 'all') values.prisonId = scope.prisonId
      assertChannelScope(scope, values.prisonId)

      const row = db()
        .update(paymentChannels)
        .set({ ...values, updatedBy: staff.id })
        .where(eq(paymentChannels.id, id))
        .returning()
        .get()

      const ctx = requestContext(c)
      writeAudit({
        actorType: 'staff',
        actorId: staff.id,
        action: 'payment_channel.updated',
        entity: 'payment_channel',
        entityId: id,
        prisonId: row.prisonId,
        before: { rail: before.rail, isActive: before.isActive, priority: before.priority },
        after: { rail: row.rail, isActive: row.isActive, priority: row.priority },
        ip: ctx.ip,
        userAgent: ctx.userAgent
      })
      return c.json(toChannelAdmin(row, db()), 200)
    }
  )

  /* ── the payment list (p.9) ────────────────────────────────────────── */

  app.openapi(
    createRoute({
      method: 'get',
      path: '/payments',
      tags: ['admin:payments'],
      summary: 'รายการชำระเงิน',
      security: bearerAuth,
      request: {
        query: PageQuery.extend({
          prisonId: Ulid.optional(),
          status: PaymentState.optional(),
          rail: PaymentRail.optional(),
          purpose: PaymentPurpose.optional(),
          channelId: Ulid.optional(),
          /** เลขที่รายการ เลขอ้างอิง หรือชื่อผู้ชำระ */
          q: z.string().max(80).optional(),
          from: z.coerce.number().int().optional(),
          to: z.coerce.number().int().optional()
        })
      },
      responses: { 200: jsonRes(pageOf(PaymentSummary), 'รายการชำระเงิน'), ...commonErrors }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const q = c.req.valid('query')
      const prisonId = resolvePrisonId(scope, q.prisonId ?? null)
      const after = decodeCursor(q.cursor)

      const rows = paymentSummaryQuery(db())
        .where(
          and(
            prisonId ? eq(payments.prisonId, prisonId) : scopeFilter(scope, payments.prisonId),
            q.status ? eq(payments.status, q.status) : undefined,
            q.rail ? eq(payments.rail, q.rail) : undefined,
            q.purpose ? eq(payments.purpose, q.purpose) : undefined,
            q.channelId ? eq(payments.channelId, q.channelId) : undefined,
            q.from ? gte(payments.createdAt, q.from) : undefined,
            q.to ? lte(payments.createdAt, q.to) : undefined,
            q.q
              ? or(like(payments.paymentNo, `%${q.q}%`), like(payments.transRef, `%${q.q}%`))
              : undefined,
            after
              ? sql`(${payments.createdAt}, ${payments.id}) < (${after[0]}, ${after[1]})`
              : undefined
          )
        )
        .orderBy(desc(payments.createdAt), desc(payments.id))
        .limit(q.limit + 1)
        .all()

      const page = paginate(rows, q.limit, (r) => [r.createdAt, r.id])
      const orderNos = orderNosFor(page.items, db())
      const depositNos = depositNosFor(page.items, db())
      const purchaseNos = letterPurchaseNosFor(page.items, db())
      return c.json(
        {
          items: page.items.map((r) => ({
            ...r,
            orderNo: orderNos.get(r.purposeId) ?? null,
            depositNo: depositNos.get(r.purposeId) ?? null,
            letterPurchaseNo: purchaseNos.get(r.purposeId) ?? null
          })),
          nextCursor: page.nextCursor
        },
        200
      )
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/payments/{id}',
      tags: ['admin:payments'],
      summary: 'รายละเอียดการชำระเงิน',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(PaymentDetail, 'รายการชำระเงิน'), ...commonErrors }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const { detail } = paymentDetail(c.req.valid('param').id, db())
      assertInScope(scope, detail.prisonId)
      return c.json(detail, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/payments/{id}/verify',
      tags: ['admin:payments'],
      summary: 'ยืนยันการชำระเงินจากสลิป',
      description:
        'ยอดต้องตรงกับ charge_satang แบบตรงตัวทุกสตางค์ เลขอ้างอิงต้องไม่เคยถูกใช้ ' +
        'และเวลาโอนต้องอยู่ในช่วงอายุของรายการนี้',
      security: bearerAuth,
      middleware: [canVerify] as const,
      request: { params: z.object({ id: Ulid }), body: jsonBody(VerifyPaymentInput) },
      responses: { 200: jsonRes(PaymentDetail, 'รายการที่ยืนยันแล้ว'), ...commonErrors }
    }),
    async (c) => {
      const staff = c.get('staff')!
      const scope = prisonScope(staff)
      const { id } = c.req.valid('param')
      const { detail } = paymentDetail(id, db())
      assertInScope(scope, detail.prisonId)

      const ctx = requestContext(c)
      const after = await verifyPayment(staff.id, id, c.req.valid('json'), {
        ip: ctx.ip,
        userAgent: ctx.userAgent
      })
      return c.json(after, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/payments/{id}/reject',
      tags: ['admin:payments'],
      summary: 'ปฏิเสธสลิป',
      description: 'คำสั่งซื้อกลับไปเป็น "ยังไม่ชำระ" เพื่อให้ญาติชำระใหม่ได้ พร้อมแจ้งเหตุผล',
      security: bearerAuth,
      middleware: [canVerify] as const,
      request: { params: z.object({ id: Ulid }), body: jsonBody(RejectPaymentInput) },
      responses: { 200: jsonRes(PaymentDetail, 'รายการที่ปฏิเสธแล้ว'), ...commonErrors }
    }),
    async (c) => {
      const staff = c.get('staff')!
      const scope = prisonScope(staff)
      const { id } = c.req.valid('param')
      const { detail } = paymentDetail(id, db())
      assertInScope(scope, detail.prisonId)

      const ctx = requestContext(c)
      const after = await rejectPayment(staff.id, id, c.req.valid('json').reason, {
        ip: ctx.ip,
        userAgent: ctx.userAgent
      })
      return c.json(after, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/payments/{id}/refund',
      tags: ['admin:payments'],
      summary: 'บันทึกการคืนเงิน',
      description:
        'บันทึกสถานะเท่านั้น — เงินคืนผ่านช่องทางที่การเงินใช้จริง แต่บันทึกนี้คือสิ่งที่ทำให้ยกเลิกคำสั่งซื้อที่ชำระแล้วได้',
      security: bearerAuth,
      middleware: [canVerify] as const,
      request: { params: z.object({ id: Ulid }), body: jsonBody(RefundPaymentInput) },
      responses: { 200: jsonRes(PaymentDetail, 'รายการที่คืนเงินแล้ว'), ...commonErrors }
    }),
    async (c) => {
      const staff = c.get('staff')!
      const scope = prisonScope(staff)
      const { id } = c.req.valid('param')
      const { detail } = paymentDetail(id, db())
      assertInScope(scope, detail.prisonId)

      const ctx = requestContext(c)
      const after = await refundPayment(staff.id, id, c.req.valid('json').reason, {
        ip: ctx.ip,
        userAgent: ctx.userAgent
      })
      return c.json(after, 200)
    }
  )

  app.get('/payments/:id/slip', async (c) => {
    const scope = prisonScope(c.get('staff'))
    const { row, detail } = paymentDetail(c.req.param('id'), db())
    assertInScope(scope, detail.prisonId)
    const buf = await readSlip(row)
    return c.body(new Uint8Array(buf), 200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=300'
    })
  })

  return app
}
