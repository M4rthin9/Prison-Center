import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq, sql } from 'drizzle-orm'
import {
  PageQuery,
  PaymentChannelPublic,
  PaymentPurpose,
  PaymentView,
  SlipUploadResult,
  Ulid,
  pageOf
} from '@pc/contract'
import { db } from '../../db/client.js'
import { payments } from '../../db/schema/index.js'
import { badRequest, forbidden, notFound } from '../../lib/errors.js'
import { decodeCursor, paginate } from '../../lib/cursor.js'
import { bearerAuth, commonErrors, jsonRes } from '../../lib/openapi.js'
import { defaultHook } from '../../lib/hook.js'
import { requestContext } from '../../lib/auth/session.js'
import { MAX_SLIP_BYTES } from '../../lib/payments/slip.js'
import { blockUntilPasswordChanged, requireCustomer } from '../../middleware/auth.js'
import type { AppEnv } from '../../types.js'
import { channelsFor, readSlip, toChannelPublic, toPaymentView, uploadSlip } from './service.js'

/** `GET /payment-channels` — what a relative may pay with, and nothing more. */
export function createPaymentChannelRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireCustomer)
  app.use('*', blockUntilPasswordChanged)

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['payments'],
      summary: 'ช่องทางชำระเงินที่ใช้ได้',
      description:
        'ช่องทางของเรือนจำนั้นรวมกับช่องทางส่วนกลาง เรียงตามลำดับความสำคัญ — ไม่คืน Biller ID หรือเลขพร้อมเพย์ปลายทาง',
      security: bearerAuth,
      request: {
        query: z.object({ prisonId: Ulid, purpose: PaymentPurpose.default('order') })
      },
      responses: {
        200: jsonRes(z.object({ items: z.array(PaymentChannelPublic) }), 'ช่องทางชำระเงิน'),
        ...commonErrors
      }
    }),
    (c) => {
      const { prisonId, purpose } = c.req.valid('query')
      const items = channelsFor(prisonId, purpose, db()).map(toChannelPublic)
      return c.json({ items }, 200)
    }
  )

  return app
}

const SlipBody = {
  content: {
    'multipart/form-data': {
      schema: z.object({
        file: z.any().openapi({ type: 'string', format: 'binary' })
      })
    }
  },
  required: true as const
}

export function createPaymentRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireCustomer)
  app.use('*', blockUntilPasswordChanged)

  const own = (id: string, customerId: string) => {
    const row = db().select().from(payments).where(eq(payments.id, id)).get()
    if (!row) throw notFound('ไม่พบรายการชำระเงิน')
    if (row.customerId !== customerId) throw forbidden('ไม่มีสิทธิ์เข้าถึงรายการชำระเงินนี้')
    return row
  }

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['payments'],
      summary: 'ประวัติการชำระเงินของฉัน',
      security: bearerAuth,
      request: { query: PageQuery },
      responses: { 200: jsonRes(pageOf(PaymentView), 'รายการชำระเงิน'), ...commonErrors }
    }),
    async (c) => {
      const me = c.get('customer')!
      const { cursor, limit } = c.req.valid('query')
      const after = decodeCursor(cursor)

      const rows = db()
        .select()
        .from(payments)
        .where(
          and(
            eq(payments.customerId, me.id),
            after
              ? sql`(${payments.createdAt}, ${payments.id}) < (${after[0]}, ${after[1]})`
              : undefined
          )
        )
        .orderBy(desc(payments.createdAt), desc(payments.id))
        .limit(limit + 1)
        .all()

      const page = paginate(rows, limit, (r) => [r.createdAt, r.id])
      const items = await Promise.all(page.items.map((r) => toPaymentView(r, db())))
      return c.json({ items, nextCursor: page.nextCursor }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/{id}',
      tags: ['payments'],
      summary: 'รายละเอียดการชำระเงิน',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(PaymentView, 'รายการชำระเงิน'), ...commonErrors }
    }),
    async (c) => {
      const me = c.get('customer')!
      const row = own(c.req.valid('param').id, me.id)
      return c.json(await toPaymentView(row, db()), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/slip',
      tags: ['payments'],
      summary: 'อัปโหลดสลิปโอนเงิน',
      description:
        'ระบบจะลบข้อมูล EXIF ย่อภาพ และพยายามอ่าน mini-QR บนสลิปเพื่อกรอกเลขอ้างอิงให้อัตโนมัติ — ' +
        'ค่าที่อ่านได้เป็นเพียงตัวช่วย ไม่ใช่หลักฐานการชำระเงิน',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }), body: SlipBody },
      responses: { 201: jsonRes(SlipUploadResult, 'สลิปที่อัปโหลดแล้ว'), ...commonErrors }
    }),
    async (c) => {
      const me = c.get('customer')!
      const { id } = c.req.valid('param')
      own(id, me.id)

      const body = await c.req.parseBody()
      const file = body['file']
      if (!(file instanceof File)) throw badRequest('ต้องแนบไฟล์ภาพสลิปในฟิลด์ "file"')
      if (file.size > MAX_SLIP_BYTES) throw badRequest('ไฟล์สลิปใหญ่เกิน 8 MB')

      const ctx = requestContext(c)
      const result = await uploadSlip(
        me.id,
        id,
        {
          buffer: Buffer.from(await file.arrayBuffer()),
          contentType: file.type || undefined,
          filename: file.name
        },
        { ip: ctx.ip, userAgent: ctx.userAgent }
      )
      return c.json(result, 201)
    }
  )

  // The slip is served through the API, not from a public URL: it is a
  // financial document about a named person (PDPA, §12 #8).
  app.get('/:id/slip', async (c) => {
    const me = c.get('customer')!
    const row = own(c.req.param('id'), me.id)
    const buf = await readSlip(row)
    return c.body(new Uint8Array(buf), 200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=300'
    })
  })

  return app
}
