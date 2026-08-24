import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import { and, desc, eq } from 'drizzle-orm'
import { LinkInmateInput, MeResponse, UpdateMeInput } from '@pc/contract'
import { db } from '../../db/client.js'
import { customerInmates, customers, inmates, prisons, zones } from '../../db/schema/index.js'
import { writeAudit } from '../../lib/audit.js'
import { conflict, notFound, unauthorized } from '../../lib/errors.js'
import { bearerAuth, commonErrors, jsonBody, jsonRes } from '../../lib/openapi.js'
import { defaultHook } from '../../lib/hook.js'
import { blockUntilPasswordChanged, requireCustomer } from '../../middleware/auth.js'
import { requestContext } from '../../lib/auth/session.js'
import type { AppEnv } from '../../types.js'

export function buildMe(customerId: string) {
  const me = db().select().from(customers).where(eq(customers.id, customerId)).get()
  if (!me) throw unauthorized()

  const links = db()
    .select({
      id: customerInmates.id,
      inmateId: inmates.id,
      inmateCode: inmates.inmateCode,
      fullName: inmates.fullName,
      prisonId: prisons.id,
      prisonName: prisons.nameTh,
      zoneId: zones.id,
      zoneName: zones.name,
      relationship: customerInmates.relationship,
      verifyStatus: customerInmates.verifyStatus
    })
    .from(customerInmates)
    .innerJoin(inmates, eq(customerInmates.inmateId, inmates.id))
    .innerJoin(prisons, eq(inmates.prisonId, prisons.id))
    .leftJoin(zones, eq(inmates.zoneId, zones.id))
    .where(eq(customerInmates.customerId, customerId))
    .orderBy(desc(customerInmates.createdAt))
    .all()

  return {
    id: me.id,
    username: me.username,
    fullName: me.fullName,
    phone: me.phone,
    lineIdText: me.lineIdText,
    lineLinked: me.lineUserId !== null,
    mustChangePassword: me.mustChangePassword,
    inmates: links,
    // Letter credits are a Phase 4 ledger; the shape exists from day one so the
    // customer app never changes when it lands.
    credits: [
      { direction: 'to_prison' as const, balance: 0 },
      { direction: 'to_home' as const, balance: 0 }
    ]
  }
}

export function createMeRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireCustomer)
  // A one-time password must not stay usable: nothing here resolves until the
  // relative has set a real password.
  app.use('*', blockUntilPasswordChanged)

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['me'],
      summary: 'โปรไฟล์ ผู้ต้องขังที่ผูกไว้ และยอดเครดิตจดหมาย',
      security: bearerAuth,
      responses: { 200: jsonRes(MeResponse, 'โปรไฟล์'), ...commonErrors }
    }),
    (c) => c.json(buildMe(c.get('customer')!.id), 200)
  )

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/',
      tags: ['me'],
      summary: 'แก้ไขโปรไฟล์',
      security: bearerAuth,
      request: { body: jsonBody(UpdateMeInput) },
      responses: { 200: jsonRes(MeResponse, 'โปรไฟล์ที่อัปเดตแล้ว'), ...commonErrors }
    }),
    (c) => {
      const me = c.get('customer')!
      const input = c.req.valid('json')
      const before = db().select().from(customers).where(eq(customers.id, me.id)).get()

      // The phone number is the username — moving it moves the login.
      if (input.phone && input.phone !== before?.phone) {
        const taken = db()
          .select({ id: customers.id })
          .from(customers)
          .where(eq(customers.username, input.phone))
          .get()
        if (taken && taken.id !== me.id) throw conflict('เบอร์มือถือนี้ถูกใช้แล้ว')
      }

      db()
        .update(customers)
        .set({
          ...(input.fullName ? { fullName: input.fullName } : {}),
          ...(input.phone ? { phone: input.phone, username: input.phone } : {}),
          ...(input.lineIdText !== undefined ? { lineIdText: input.lineIdText } : {})
        })
        .where(eq(customers.id, me.id))
        .run()

      const ctx = requestContext(c)
      writeAudit({
        actorType: 'customer',
        actorId: me.id,
        action: 'me.update',
        entity: 'customer',
        entityId: me.id,
        before,
        after: input,
        ip: ctx.ip,
        userAgent: ctx.userAgent
      })
      return c.json(buildMe(me.id), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/inmates',
      tags: ['me'],
      summary: 'ขอผูกบัญชีกับผู้ต้องขัง',
      description:
        'สร้างคำขอสถานะ pending — เจ้าหน้าที่ต้องอนุมัติก่อนจึงจะฝากเงิน ส่งจดหมาย หรือจองเยี่ยมได้',
      security: bearerAuth,
      request: { body: jsonBody(LinkInmateInput) },
      responses: { 201: jsonRes(MeResponse, 'ส่งคำขอแล้ว'), ...commonErrors }
    }),
    (c) => {
      const me = c.get('customer')!
      const input = c.req.valid('json')

      const inmate = db().select().from(inmates).where(eq(inmates.id, input.inmateId)).get()
      if (!inmate || inmate.deletedAt) throw notFound('ไม่พบผู้ต้องขัง')

      const existing = db()
        .select({ id: customerInmates.id })
        .from(customerInmates)
        .where(
          and(eq(customerInmates.customerId, me.id), eq(customerInmates.inmateId, input.inmateId))
        )
        .get()
      if (existing) throw conflict('มีคำขอผูกบัญชีกับผู้ต้องขังรายนี้อยู่แล้ว')

      const row = db()
        .insert(customerInmates)
        .values({
          customerId: me.id,
          inmateId: input.inmateId,
          relationship: input.relationship,
          verifyStatus: 'pending'
        })
        .returning()
        .get()

      const ctx = requestContext(c)
      writeAudit({
        actorType: 'customer',
        actorId: me.id,
        action: 'me.link_inmate_requested',
        entity: 'customer_inmate',
        entityId: row.id,
        prisonId: inmate.prisonId,
        after: { inmateId: input.inmateId, relationship: input.relationship },
        ip: ctx.ip,
        userAgent: ctx.userAgent
      })
      return c.json(buildMe(me.id), 201)
    }
  )

  return app
}
