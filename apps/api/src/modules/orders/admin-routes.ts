import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq, gte, like, lte, or, sql } from 'drizzle-orm'
import {
  FulfillmentStatus,
  OrderDetail,
  OrderSummary,
  PageQuery,
  PaymentStatus,
  Ulid,
  UpdateFulfillmentInput,
  pageOf
} from '@pc/contract'
import { db } from '../../db/client.js'
import { orders } from '../../db/schema/index.js'
import { writeAudit } from '../../lib/audit.js'
import { badRequest, conflict } from '../../lib/errors.js'
import { decodeCursor, paginate } from '../../lib/cursor.js'
import { bearerAuth, commonErrors, jsonBody, jsonRes } from '../../lib/openapi.js'
import { defaultHook } from '../../lib/hook.js'
import { notify } from '../../lib/notify/index.js'
import { requestContext } from '../../lib/auth/session.js'
import { formatBaht } from '../../lib/money.js'
import { now } from '../../lib/time.js'
import { blockUntilPasswordChanged, requireRole, requireStaff } from '../../middleware/auth.js'
import {
  assertInScope,
  prisonScope,
  resolvePrisonId,
  scopeFilter
} from '../../middleware/prison-scope.js'
import type { AppEnv } from '../../types.js'
import {
  assertFulfillmentTransition,
  itemCounts,
  orderDetail,
  orderSummaryQuery
} from './service.js'

export function createAdminOrderRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireStaff)
  app.use('*', blockUntilPasswordChanged)

  app.openapi(
    createRoute({
      method: 'get',
      path: '/orders',
      tags: ['admin:orders'],
      summary: 'คำสั่งซื้อทั้งหมดในขอบเขตของผู้ใช้',
      security: bearerAuth,
      request: {
        query: PageQuery.extend({
          prisonId: Ulid.optional(),
          zoneId: Ulid.optional(),
          shopId: Ulid.optional(),
          fulfillmentStatus: FulfillmentStatus.optional(),
          paymentStatus: PaymentStatus.optional(),
          /** เลขคำสั่งซื้อ ชื่อผู้ต้องขัง หรือรหัสผู้ต้องขัง */
          q: z.string().max(80).optional(),
          from: z.coerce.number().int().optional(),
          to: z.coerce.number().int().optional()
        })
      },
      responses: { 200: jsonRes(pageOf(OrderSummary), 'รายการคำสั่งซื้อ'), ...commonErrors }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const q = c.req.valid('query')
      const prisonId = resolvePrisonId(scope, q.prisonId ?? null)
      const after = decodeCursor(q.cursor)

      const rows = orderSummaryQuery(db())
        .where(
          and(
            prisonId ? eq(orders.prisonId, prisonId) : scopeFilter(scope, orders.prisonId),
            q.zoneId ? eq(orders.zoneId, q.zoneId) : undefined,
            q.shopId ? eq(orders.shopId, q.shopId) : undefined,
            q.fulfillmentStatus ? eq(orders.fulfillmentStatus, q.fulfillmentStatus) : undefined,
            q.paymentStatus ? eq(orders.paymentStatus, q.paymentStatus) : undefined,
            q.from ? gte(orders.orderedAt, q.from) : undefined,
            q.to ? lte(orders.orderedAt, q.to) : undefined,
            q.q
              ? or(
                  like(orders.orderNo, `%${q.q}%`),
                  like(orders.inmateNameSnapshot, `%${q.q}%`),
                  like(orders.inmateCodeSnapshot, `%${q.q}%`)
                )
              : undefined,
            after
              ? sql`(${orders.orderedAt}, ${orders.id}) < (${after[0]}, ${after[1]})`
              : undefined
          )
        )
        .orderBy(desc(orders.orderedAt), desc(orders.id))
        .limit(q.limit + 1)
        .all()

      const page = paginate(rows, q.limit, (r) => [r.orderedAt, r.id])
      const counts = itemCounts(
        page.items.map((r) => r.id),
        db()
      )
      return c.json(
        {
          items: page.items.map((r) => ({ ...r, itemCount: counts.get(r.id) ?? 0 })),
          nextCursor: page.nextCursor
        },
        200
      )
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/orders/{id}',
      tags: ['admin:orders'],
      summary: 'รายละเอียดคำสั่งซื้อ',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(OrderDetail, 'คำสั่งซื้อ'), ...commonErrors }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const detail = orderDetail(c.req.valid('param').id)
      assertInScope(scope, detail.prisonId)
      return c.json(detail, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/orders/{id}/fulfillment',
      tags: ['admin:orders'],
      summary: 'อัปเดตสถานะการจัดเตรียม/ส่งมอบ',
      description:
        'new → preparing → delivered และยกเลิกได้ก่อนส่งมอบ — สถานะที่จบแล้วเปลี่ยนกลับไม่ได้',
      security: bearerAuth,
      middleware: [requireRole('super_admin', 'prison_admin', 'zone_staff')] as const,
      request: { params: z.object({ id: Ulid }), body: jsonBody(UpdateFulfillmentInput) },
      responses: { 200: jsonRes(OrderDetail, 'คำสั่งซื้อที่อัปเดตแล้ว'), ...commonErrors }
    }),
    async (c) => {
      const staff = c.get('staff')!
      const scope = prisonScope(staff)
      const { id } = c.req.valid('param')
      const { status, reason } = c.req.valid('json')

      const before = orderDetail(id)
      assertInScope(scope, before.prisonId)
      assertFulfillmentTransition(before.fulfillmentStatus, status)

      if (status === 'cancelled') {
        if (!reason?.trim()) throw badRequest('ต้องระบุเหตุผลที่ยกเลิก')
        // Refunds are a Phase 2 concern; until the payment spine exists, a paid
        // order must not be cancelled from this screen.
        if (before.paymentStatus === 'paid' || before.paymentStatus === 'awaiting_verify') {
          throw conflict('คำสั่งซื้อที่ชำระเงินแล้วต้องดำเนินการคืนเงินก่อน (เฟส 2)')
        }
      }

      const at = now()
      db()
        .update(orders)
        .set({
          fulfillmentStatus: status,
          ...(status === 'delivered' ? { fulfilledAt: at } : {}),
          ...(status === 'cancelled'
            ? { cancelledAt: at, cancelReason: reason?.trim() ?? null }
            : {}),
          updatedBy: staff.id
        })
        .where(eq(orders.id, id))
        .run()

      const after = orderDetail(id)
      const ctx = requestContext(c)
      writeAudit({
        actorType: 'staff',
        actorId: staff.id,
        action: 'order.fulfillment_updated',
        entity: 'order',
        entityId: id,
        prisonId: after.prisonId,
        before: { fulfillmentStatus: before.fulfillmentStatus },
        after: { fulfillmentStatus: status, reason: reason ?? null },
        ip: ctx.ip,
        userAgent: ctx.userAgent
      })

      if (status === 'delivered' || status === 'cancelled') {
        await notify({
          audience: 'customer',
          recipientId: after.customerId,
          kind: 'order.ready',
          title:
            status === 'delivered'
              ? `ส่งมอบคำสั่งซื้อ ${after.orderNo} แล้ว`
              : `คำสั่งซื้อ ${after.orderNo} ถูกยกเลิก`,
          body:
            status === 'delivered'
              ? `สินค้ามูลค่า ${formatBaht(after.totalSatang)} ถึงมือ ${after.inmateName} แล้ว`
              : (reason ?? 'เจ้าหน้าที่ยกเลิกคำสั่งซื้อนี้'),
          data: { orderId: id, orderNo: after.orderNo, status }
        })
      }

      return c.json(after, 200)
    }
  )

  return app
}
