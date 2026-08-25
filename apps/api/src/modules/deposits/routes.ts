import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq, sql } from 'drizzle-orm'
import {
  CreateDepositCardInput,
  CreateDepositInput,
  DepositCard,
  DepositDetail,
  DepositStatus,
  DepositSummary,
  PageQuery,
  Ulid,
  pageOf
} from '@pc/contract'
import { db } from '../../db/client.js'
import { depositCards, deposits } from '../../db/schema/index.js'
import { forbidden } from '../../lib/errors.js'
import { decodeCursor, paginate } from '../../lib/cursor.js'
import { bearerAuth, commonErrors, jsonBody, jsonRes } from '../../lib/openapi.js'
import { defaultHook } from '../../lib/hook.js'
import { requestContext } from '../../lib/auth/session.js'
import { blockUntilPasswordChanged, requireCustomer } from '../../middleware/auth.js'
import type { AppEnv } from '../../types.js'
import {
  cancelDeposit,
  createDeposit,
  createDepositPayment,
  depositCardQuery,
  depositDetail,
  depositSummaryQuery,
  paymentStatusesFor,
  requestDepositCard
} from './service.js'

/** `POST /deposit-cards` — ลงทะเบียนทำบัตรฝากเงิน (p.13). */
export function createDepositCardRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireCustomer)
  app.use('*', blockUntilPasswordChanged)

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['deposits'],
      summary: 'บัตรฝากเงินของฉัน',
      security: bearerAuth,
      responses: {
        200: jsonRes(z.object({ items: z.array(DepositCard) }), 'บัตรฝากเงิน'),
        ...commonErrors
      }
    }),
    (c) => {
      const me = c.get('customer')!
      const items = depositCardQuery(db())
        .where(eq(depositCards.customerId, me.id))
        .orderBy(desc(depositCards.createdAt))
        .all()
      return c.json({ items }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['deposits'],
      summary: 'ลงทะเบียนทำบัตรฝากเงิน',
      description:
        'ทำครั้งเดียวต่อผู้ต้องขังหนึ่งราย และต้องผูกบัญชีกับผู้ต้องขังรายนั้นโดยได้รับการยืนยันแล้ว',
      security: bearerAuth,
      request: { body: jsonBody(CreateDepositCardInput) },
      responses: { 201: jsonRes(DepositCard, 'คำขอทำบัตร'), ...commonErrors }
    }),
    (c) => {
      const me = c.get('customer')!
      const ctx = requestContext(c)
      return c.json(requestDepositCard(me.id, c.req.valid('json'), ctx), 201)
    }
  )

  return app
}

export function createDepositRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireCustomer)
  app.use('*', blockUntilPasswordChanged)

  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['deposits'],
      summary: 'สร้างรายการฝากเงิน',
      description:
        'สร้างรายการพร้อม QR ชำระเงินในครั้งเดียว — อัปโหลดสลิปผ่าน /payments/{id}/slip เหมือนคำสั่งซื้อ',
      security: bearerAuth,
      request: { body: jsonBody(CreateDepositInput) },
      responses: { 201: jsonRes(DepositDetail, 'รายการฝากเงิน'), ...commonErrors }
    }),
    async (c) => {
      const me = c.get('customer')!
      const ctx = requestContext(c)
      return c.json(await createDeposit(me.id, c.req.valid('json'), ctx), 201)
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['deposits'],
      summary: 'ประวัติการฝากเงินของฉัน',
      security: bearerAuth,
      request: { query: PageQuery.extend({ status: DepositStatus.optional() }) },
      responses: { 200: jsonRes(pageOf(DepositSummary), 'รายการฝากเงิน'), ...commonErrors }
    }),
    (c) => {
      const me = c.get('customer')!
      const { cursor, limit, status } = c.req.valid('query')
      const after = decodeCursor(cursor)

      const rows = depositSummaryQuery(db())
        .where(
          and(
            eq(deposits.customerId, me.id),
            status ? eq(deposits.status, status) : undefined,
            after
              ? sql`(${deposits.createdAt}, ${deposits.id}) < (${after[0]}, ${after[1]})`
              : undefined
          )
        )
        .orderBy(desc(deposits.createdAt), desc(deposits.id))
        .limit(limit + 1)
        .all()

      const page = paginate(rows, limit, (r) => [r.createdAt, r.id])
      const statuses = paymentStatusesFor(page.items, db())
      return c.json(
        {
          items: page.items.map((r) => ({ ...r, paymentStatus: statuses.get(r.id) ?? null })),
          nextCursor: page.nextCursor
        },
        200
      )
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/payment',
      tags: ['deposits'],
      summary: 'ขอ QR ใหม่ของรายการฝากเงิน',
      description:
        'ใช้เมื่อ QR หมดอายุหรือต้องการเปลี่ยนช่องทาง — ยอดและเลขที่รายการเดิมไม่เปลี่ยน',
      security: bearerAuth,
      request: {
        params: z.object({ id: Ulid }),
        body: jsonBody(z.object({ channelId: Ulid.optional() }))
      },
      responses: { 201: jsonRes(DepositDetail, 'รายการฝากเงิน'), ...commonErrors }
    }),
    async (c) => {
      const me = c.get('customer')!
      const ctx = requestContext(c)
      const detail = await createDepositPayment(
        me.id,
        c.req.valid('param').id,
        c.req.valid('json'),
        ctx
      )
      return c.json(detail, 201)
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/{id}',
      tags: ['deposits'],
      summary: 'รายละเอียดการฝากเงิน',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(DepositDetail, 'รายการฝากเงิน'), ...commonErrors }
    }),
    async (c) => {
      const me = c.get('customer')!
      const detail = await depositDetail(c.req.valid('param').id)
      // Checked on the row, never inferred from the id being unguessable.
      if (detail.customerId !== me.id) throw forbidden('ไม่มีสิทธิ์เข้าถึงรายการฝากเงินนี้')
      return c.json(detail, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/cancel',
      tags: ['deposits'],
      summary: 'ยกเลิกรายการฝากเงินที่ยังไม่ได้ชำระ',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(DepositDetail, 'ยกเลิกแล้ว'), ...commonErrors }
    }),
    async (c) => {
      const me = c.get('customer')!
      return c.json(await cancelDeposit(me.id, c.req.valid('param').id), 200)
    }
  )

  return app
}
