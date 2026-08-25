import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq, sql } from 'drizzle-orm'
import {
  CreateOrderInput,
  FulfillmentStatus,
  OrderDetail,
  OrderSummary,
  PageQuery,
  Ulid,
  pageOf
} from '@pc/contract'
import { db } from '../../db/client.js'
import { orders } from '../../db/schema/index.js'
import { forbidden } from '../../lib/errors.js'
import { decodeCursor, paginate } from '../../lib/cursor.js'
import { bearerAuth, commonErrors, jsonBody, jsonRes } from '../../lib/openapi.js'
import { defaultHook } from '../../lib/hook.js'
import { requestContext } from '../../lib/auth/session.js'
import { blockUntilPasswordChanged, requireCustomer } from '../../middleware/auth.js'
import type { AppEnv } from '../../types.js'
import { itemCounts, orderDetail, orderSummaryQuery, placeOrder } from './service.js'

export function createOrderRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireCustomer)
  app.use('*', blockUntilPasswordChanged)

  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['orders'],
      summary: 'สร้างคำสั่งซื้อจากตะกร้า',
      description:
        'เซิร์ฟเวอร์คำนวณราคาใหม่ทุกครั้งจากตาราง products — ไคลเอนต์ส่งเฉพาะรหัสสินค้าและจำนวน',
      security: bearerAuth,
      request: { body: jsonBody(CreateOrderInput) },
      responses: { 201: jsonRes(OrderDetail, 'คำสั่งซื้อที่สร้างแล้ว'), ...commonErrors }
    }),
    (c) => {
      const me = c.get('customer')!
      const ctx = requestContext(c)
      const detail = placeOrder(me.id, c.req.valid('json'), {
        ip: ctx.ip,
        userAgent: ctx.userAgent
      })
      return c.json(detail, 201)
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['orders'],
      summary: 'ประวัติการสั่งซื้อ',
      security: bearerAuth,
      request: { query: PageQuery.extend({ status: FulfillmentStatus.optional() }) },
      responses: { 200: jsonRes(pageOf(OrderSummary), 'รายการคำสั่งซื้อ'), ...commonErrors }
    }),
    (c) => {
      const me = c.get('customer')!
      const { cursor, limit, status } = c.req.valid('query')
      const after = decodeCursor(cursor)

      const rows = orderSummaryQuery(db())
        .where(
          and(
            eq(orders.customerId, me.id),
            status ? eq(orders.fulfillmentStatus, status) : undefined,
            // Newest first, so the keyset walks downwards.
            after
              ? sql`(${orders.orderedAt}, ${orders.id}) < (${after[0]}, ${after[1]})`
              : undefined
          )
        )
        .orderBy(desc(orders.orderedAt), desc(orders.id))
        .limit(limit + 1)
        .all()

      const page = paginate(rows, limit, (r) => [r.orderedAt, r.id])
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
      path: '/{id}',
      tags: ['orders'],
      summary: 'รายละเอียดคำสั่งซื้อ',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(OrderDetail, 'คำสั่งซื้อ'), ...commonErrors }
    }),
    (c) => {
      const me = c.get('customer')!
      const detail = orderDetail(c.req.valid('param').id)
      // A relative may only ever read their own order — checked on the row, not
      // inferred from the id being unguessable.
      if (detail.customerId !== me.id) throw forbidden('ไม่มีสิทธิ์เข้าถึงคำสั่งซื้อนี้')
      return c.json(detail, 200)
    }
  )

  return app
}
