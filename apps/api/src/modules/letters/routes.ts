import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq, or, sql } from 'drizzle-orm'
import {
  CreateLetterInput,
  LetterCredits,
  LetterDetail,
  LetterDirection,
  LetterPackage,
  LetterPurchaseDetail,
  LetterPurchaseSummary,
  LetterStatus,
  LetterSummary,
  PageQuery,
  PurchaseLetterPackageInput,
  UpdateLetterInput,
  Ulid,
  pageOf
} from '@pc/contract'
import { db } from '../../db/client.js'
import { letterPurchases, letters } from '../../db/schema/index.js'
import { badRequest, forbidden, notFound } from '../../lib/errors.js'
import { decodeCursor, paginate } from '../../lib/cursor.js'
import { MAX_ATTACHMENT_BYTES } from '../../lib/letters/image.js'
import { bearerAuth, commonErrors, jsonBody, jsonRes } from '../../lib/openapi.js'
import { defaultHook } from '../../lib/hook.js'
import { requestContext } from '../../lib/auth/session.js'
import { blockUntilPasswordChanged, requireCustomer } from '../../middleware/auth.js'
import type { AppEnv } from '../../types.js'
import { letterCredits } from './credits.js'
import {
  addAttachment,
  cancelLetter,
  createLetter,
  createPurchasePayment,
  letterDetail,
  letterPurchaseDetail,
  letterPurchaseQuery,
  letterQuery,
  packagesFor,
  purchasePackage,
  purchasePaymentStatuses,
  readAttachment,
  readScan,
  removeAttachment,
  replyInfoFor,
  submitLetter,
  updateLetter
} from './service.js'

const AttachmentBody = {
  content: {
    'multipart/form-data': {
      schema: z.object({ file: z.any().openapi({ type: 'string', format: 'binary' }) })
    }
  },
  required: true as const
}

/** `GET /letter-packages`, `POST /letter-packages/{id}/purchase` (p.12). */
export function createLetterPackageRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireCustomer)
  app.use('*', blockUntilPasswordChanged)

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['letters'],
      summary: 'แพ็กเกจจดหมายที่ซื้อได้',
      description: 'แพ็กเกจของเรือนจำนั้นรวมกับแพ็กเกจส่วนกลาง',
      security: bearerAuth,
      request: {
        query: z.object({ prisonId: Ulid.optional(), direction: LetterDirection.optional() })
      },
      responses: {
        200: jsonRes(z.object({ items: z.array(LetterPackage) }), 'แพ็กเกจ'),
        ...commonErrors
      }
    }),
    (c) => {
      const { prisonId, direction } = c.req.valid('query')
      return c.json({ items: packagesFor(prisonId ?? null, { direction }, db()) }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/purchase',
      tags: ['letters'],
      summary: 'ซื้อแพ็กเกจจดหมาย',
      description:
        'สร้างรายการซื้อพร้อม QR ชำระเงินในครั้งเดียว — สิทธิ์จะเข้าบัญชีเมื่อเจ้าหน้าที่ตรวจสลิปผ่านแล้วเท่านั้น',
      security: bearerAuth,
      request: {
        params: z.object({ id: Ulid }),
        body: jsonBody(PurchaseLetterPackageInput)
      },
      responses: { 201: jsonRes(LetterPurchaseDetail, 'รายการซื้อ'), ...commonErrors }
    }),
    async (c) => {
      const me = c.get('customer')!
      const detail = await purchasePackage(
        me.id,
        c.req.valid('param').id,
        c.req.valid('json'),
        requestContext(c)
      )
      return c.json(detail, 201)
    }
  )

  return app
}

/** `GET/POST /letter-purchases` — ประวัติการเติมสิทธิ์ (p.4). */
export function createLetterPurchaseRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireCustomer)
  app.use('*', blockUntilPasswordChanged)

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['letters'],
      summary: 'ประวัติการซื้อแพ็กเกจจดหมาย',
      security: bearerAuth,
      request: { query: PageQuery },
      responses: { 200: jsonRes(pageOf(LetterPurchaseSummary), 'รายการซื้อ'), ...commonErrors }
    }),
    (c) => {
      const me = c.get('customer')!
      const { cursor, limit } = c.req.valid('query')
      const after = decodeCursor(cursor)

      const rows = letterPurchaseQuery(db())
        .where(
          and(
            eq(letterPurchases.customerId, me.id),
            after
              ? sql`(${letterPurchases.createdAt}, ${letterPurchases.id}) < (${after[0]}, ${after[1]})`
              : undefined
          )
        )
        .orderBy(desc(letterPurchases.createdAt), desc(letterPurchases.id))
        .limit(limit + 1)
        .all()

      const page = paginate(rows, limit, (r) => [r.createdAt, r.id])
      const statuses = purchasePaymentStatuses(page.items, db())
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
      method: 'get',
      path: '/{id}',
      tags: ['letters'],
      summary: 'รายละเอียดการซื้อแพ็กเกจ',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(LetterPurchaseDetail, 'รายการซื้อ'), ...commonErrors }
    }),
    async (c) => {
      const me = c.get('customer')!
      const detail = await letterPurchaseDetail(c.req.valid('param').id)
      if (detail.customerId !== me.id) throw forbidden('ไม่มีสิทธิ์เข้าถึงรายการนี้')
      return c.json(detail, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/payment',
      tags: ['letters'],
      summary: 'ขอ QR ใหม่ของรายการซื้อ',
      security: bearerAuth,
      request: {
        params: z.object({ id: Ulid }),
        body: jsonBody(z.object({ channelId: Ulid.optional() }))
      },
      responses: { 201: jsonRes(LetterPurchaseDetail, 'รายการซื้อ'), ...commonErrors }
    }),
    async (c) => {
      const me = c.get('customer')!
      const detail = await createPurchasePayment(
        me.id,
        c.req.valid('param').id,
        c.req.valid('json'),
        requestContext(c)
      )
      return c.json(detail, 201)
    }
  )

  return app
}

export function createLetterRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireCustomer)
  app.use('*', blockUntilPasswordChanged)

  /** A letter is mine if I wrote it or it was written back to me. */
  const own = (id: string, customerId: string) => {
    const row = db().select().from(letters).where(eq(letters.id, id)).get()
    if (!row) throw notFound('ไม่พบจดหมาย')
    if (row.senderCustomerId !== customerId && row.recipientCustomerId !== customerId) {
      throw forbidden('ไม่มีสิทธิ์เข้าถึงจดหมายฉบับนี้')
    }
    return row
  }

  app.openapi(
    createRoute({
      method: 'get',
      path: '/credits',
      tags: ['letters'],
      summary: 'สิทธิ์จดหมายคงเหลือและประวัติการเคลื่อนไหว',
      description: 'ยอดคงเหลือคำนวณจาก ledger เสมอ ไม่ได้เก็บเป็นตัวเลขนับ',
      security: bearerAuth,
      responses: { 200: jsonRes(LetterCredits, 'สิทธิ์คงเหลือ'), ...commonErrors }
    }),
    (c) => c.json(letterCredits(c.get('customer')!.id, db()), 200)
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['letters'],
      summary: 'จดหมายของฉัน',
      security: bearerAuth,
      request: {
        query: PageQuery.extend({
          direction: LetterDirection.optional(),
          status: LetterStatus.optional()
        })
      },
      responses: { 200: jsonRes(pageOf(LetterSummary), 'จดหมาย'), ...commonErrors }
    }),
    (c) => {
      const me = c.get('customer')!
      const { cursor, limit, direction, status } = c.req.valid('query')
      const after = decodeCursor(cursor)

      const rows = letterQuery(db())
        .where(
          and(
            or(eq(letters.senderCustomerId, me.id), eq(letters.recipientCustomerId, me.id)),
            direction ? eq(letters.direction, direction) : undefined,
            status ? eq(letters.status, status) : undefined,
            after
              ? sql`(${letters.createdAt}, ${letters.id}) < (${after[0]}, ${after[1]})`
              : undefined
          )
        )
        .orderBy(desc(letters.createdAt), desc(letters.id))
        .limit(limit + 1)
        .all()

      const page = paginate(rows, limit, (r) => [r.createdAt, r.id])
      const { decorate } = replyInfoFor(page.items, db())
      return c.json({ items: page.items.map(decorate), nextCursor: page.nextCursor }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['letters'],
      summary: 'เขียนจดหมายฉบับร่าง',
      description: 'ฉบับร่างยังไม่ใช้สิทธิ์ — สิทธิ์จะถูกตัดตอนกด "ส่งเข้าคิวพิมพ์"',
      security: bearerAuth,
      request: { body: jsonBody(CreateLetterInput) },
      responses: { 201: jsonRes(LetterDetail, 'ฉบับร่าง'), ...commonErrors }
    }),
    (c) => {
      const me = c.get('customer')!
      return c.json(createLetter(me.id, c.req.valid('json'), requestContext(c)), 201)
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/{id}',
      tags: ['letters'],
      summary: 'รายละเอียดจดหมาย',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(LetterDetail, 'จดหมาย'), ...commonErrors }
    }),
    (c) => {
      const me = c.get('customer')!
      const { id } = c.req.valid('param')
      own(id, me.id)
      return c.json(letterDetail(id), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/{id}',
      tags: ['letters'],
      summary: 'แก้ไขฉบับร่าง',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }), body: jsonBody(UpdateLetterInput) },
      responses: { 200: jsonRes(LetterDetail, 'ฉบับร่าง'), ...commonErrors }
    }),
    (c) => {
      const me = c.get('customer')!
      const { id } = c.req.valid('param')
      return c.json(updateLetter(me.id, id, c.req.valid('json').bodyText), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/attachments',
      tags: ['letters'],
      summary: 'แนบรูปกับฉบับร่าง',
      description: 'ระบบลบข้อมูล EXIF และย่อภาพก่อนจัดเก็บ เช่นเดียวกับสลิป',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }), body: AttachmentBody },
      responses: { 201: jsonRes(LetterDetail, 'ฉบับร่าง'), ...commonErrors }
    }),
    async (c) => {
      const me = c.get('customer')!
      const { id } = c.req.valid('param')
      const body = await c.req.parseBody()
      const file = body['file']
      if (!(file instanceof File)) throw badRequest('ต้องแนบไฟล์ภาพในฟิลด์ "file"')
      if (file.size > MAX_ATTACHMENT_BYTES) throw badRequest('ไฟล์รูปใหญ่เกิน 8 MB')

      const detail = await addAttachment(me.id, id, {
        buffer: Buffer.from(await file.arrayBuffer()),
        contentType: file.type || undefined,
        filename: file.name
      })
      return c.json(detail, 201)
    }
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/{id}/attachments/{attachmentId}',
      tags: ['letters'],
      summary: 'ลบรูปแนบออกจากฉบับร่าง',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid, attachmentId: Ulid }) },
      responses: { 200: jsonRes(LetterDetail, 'ฉบับร่าง'), ...commonErrors }
    }),
    async (c) => {
      const me = c.get('customer')!
      const { id, attachmentId } = c.req.valid('param')
      return c.json(await removeAttachment(me.id, id, attachmentId), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/submit',
      tags: ['letters'],
      summary: 'ส่งจดหมายเข้าคิวพิมพ์',
      description: 'ตัดสิทธิ์ 1 ฉบับในทรานแซกชันเดียวกับการเปลี่ยนสถานะ',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(LetterDetail, 'เข้าคิวแล้ว'), ...commonErrors }
    }),
    (c) => {
      const me = c.get('customer')!
      return c.json(submitLetter(me.id, c.req.valid('param').id, requestContext(c)), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/cancel',
      tags: ['letters'],
      summary: 'ยกเลิกจดหมายที่ยังไม่เข้ารอบพิมพ์',
      description: 'ถ้าตัดสิทธิ์ไปแล้ว ระบบจะคืนสิทธิ์ให้ 1 ฉบับ',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(LetterDetail, 'ยกเลิกแล้ว'), ...commonErrors }
    }),
    (c) => {
      const me = c.get('customer')!
      return c.json(cancelLetter(me.id, c.req.valid('param').id), 200)
    }
  )

  // Images go through the API, never a public bucket URL: a family photo and a
  // handwritten reply are the most sensitive data in this system (§12 #8).
  app.get('/:id/attachments/:attachmentId', async (c) => {
    const me = c.get('customer')!
    own(c.req.param('id'), me.id)
    const buf = await readAttachment(c.req.param('id'), c.req.param('attachmentId'))
    return c.body(new Uint8Array(buf), 200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=300'
    })
  })

  app.get('/:id/scan', async (c) => {
    const me = c.get('customer')!
    const row = own(c.req.param('id'), me.id)
    // A held reply is stored but not yet paid for — the scan stays sealed.
    if (row.status === 'queued' && row.direction === 'to_home') {
      throw forbidden('ต้องซื้อแพ็กเกจ "ส่งกลับบ้าน" ก่อนจึงจะเปิดอ่านจดหมายตอบกลับได้')
    }
    const buf = await readScan(c.req.param('id'))
    return c.body(new Uint8Array(buf), 200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=300'
    })
  })

  return app
}
