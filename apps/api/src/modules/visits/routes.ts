import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq, sql } from 'drizzle-orm'
import {
  CreateVisitBookingInput,
  IsoDate,
  PageQuery,
  Ulid,
  VisitAvailability,
  VisitBookingDetail,
  VisitBookingStatus,
  VisitBookingSummary,
  VisitRound,
  pageOf
} from '@pc/contract'
import { db } from '../../db/client.js'
import { visitBookings } from '../../db/schema/index.js'
import { forbidden } from '../../lib/errors.js'
import { decodeCursor, paginate } from '../../lib/cursor.js'
import { bearerAuth, commonErrors, jsonBody, jsonRes } from '../../lib/openapi.js'
import { defaultHook } from '../../lib/hook.js'
import { requestContext } from '../../lib/auth/session.js'
import { blockUntilPasswordChanged, requireCustomer } from '../../middleware/auth.js'
import type { AppEnv } from '../../types.js'
import {
  availability,
  bookingDetail,
  bookingQuery,
  cancelBooking,
  createBooking,
  listRounds
} from './service.js'

export function createVisitRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireCustomer)
  app.use('*', blockUntilPasswordChanged)

  app.openapi(
    createRoute({
      method: 'get',
      path: '/rounds',
      tags: ['visits'],
      summary: 'รอบเยี่ยมของเรือนจำ',
      security: bearerAuth,
      request: { query: z.object({ prisonId: Ulid }) },
      responses: { 200: jsonRes(z.object({ items: z.array(VisitRound) }), 'รอบเยี่ยม'), ...commonErrors }
    }),
    (c) => c.json({ items: listRounds(c.req.valid('query').prisonId, {}, db()) }, 200)
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/availability',
      tags: ['visits'],
      summary: 'ช่องเวลาเยี่ยมที่จองได้',
      description:
        'อ่านจากตารางที่เจ้าหน้าที่กำหนดเท่านั้น และกรองด้วยแดนของผู้ต้องขังรายนั้น — ไม่มีการคำนวณจากแม่แบบตอนเรียก',
      security: bearerAuth,
      request: {
        query: z.object({ inmateId: Ulid, from: IsoDate.optional(), to: IsoDate.optional() })
      },
      responses: { 200: jsonRes(VisitAvailability, 'ช่องเวลาเยี่ยม'), ...commonErrors }
    }),
    (c) => {
      const me = c.get('customer')!
      const { inmateId, from, to } = c.req.valid('query')
      return c.json(availability(me.id, inmateId, { from, to }), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['visits'],
      summary: 'จองเยี่ยมผู้ต้องขัง',
      description: 'ความจุถูกตัดด้วย UPDATE แถวเดียว — เต็มแล้วคือ 409 เสมอ ไม่มีการจองเกิน',
      security: bearerAuth,
      request: { body: jsonBody(CreateVisitBookingInput) },
      responses: { 201: jsonRes(VisitBookingDetail, 'การจองเยี่ยม'), ...commonErrors }
    }),
    async (c) => {
      const me = c.get('customer')!
      const ctx = requestContext(c)
      return c.json(await createBooking(me.id, c.req.valid('json'), ctx), 201)
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['visits'],
      summary: 'ประวัติการจองเยี่ยมของฉัน',
      security: bearerAuth,
      request: { query: PageQuery.extend({ status: VisitBookingStatus.optional() }) },
      responses: { 200: jsonRes(pageOf(VisitBookingSummary), 'การจองเยี่ยม'), ...commonErrors }
    }),
    (c) => {
      const me = c.get('customer')!
      const { cursor, limit, status } = c.req.valid('query')
      const after = decodeCursor(cursor)

      const rows = bookingQuery(db())
        .where(
          and(
            eq(visitBookings.customerId, me.id),
            status ? eq(visitBookings.status, status) : undefined,
            after
              ? sql`(${visitBookings.startsAt}, ${visitBookings.id}) < (${after[0]}, ${after[1]})`
              : undefined
          )
        )
        .orderBy(desc(visitBookings.startsAt), desc(visitBookings.id))
        .limit(limit + 1)
        .all()

      const page = paginate(rows, limit, (r) => [r.startsAt, r.id])
      return c.json(page, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/{id}',
      tags: ['visits'],
      summary: 'รายละเอียดการจองเยี่ยม',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(VisitBookingDetail, 'การจองเยี่ยม'), ...commonErrors }
    }),
    (c) => {
      const me = c.get('customer')!
      const detail = bookingDetail(c.req.valid('param').id)
      // Checked on the row, never inferred from the id being unguessable.
      if (detail.customerId !== me.id) throw forbidden('ไม่มีสิทธิ์เข้าถึงการจองนี้')
      return c.json(detail, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/cancel',
      tags: ['visits'],
      summary: 'ยกเลิกการจองเยี่ยม',
      description: 'ที่นั่งถูกคืนให้ช่องเวลาในทรานแซกชันเดียวกับการเปลี่ยนสถานะ',
      security: bearerAuth,
      request: {
        params: z.object({ id: Ulid }),
        body: jsonBody(z.object({ reason: z.string().trim().max(200).optional() }))
      },
      responses: { 200: jsonRes(VisitBookingDetail, 'ยกเลิกแล้ว'), ...commonErrors }
    }),
    async (c) => {
      const me = c.get('customer')!
      const id = c.req.valid('param').id
      const detail = bookingDetail(id)
      if (detail.customerId !== me.id) throw forbidden('ไม่มีสิทธิ์เข้าถึงการจองนี้')

      return c.json(
        await cancelBooking(id, {
          actor: 'customer',
          actorId: me.id,
          reason: c.req.valid('json').reason,
          ctx: requestContext(c)
        }),
        200
      )
    }
  )

  return app
}
