import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, count, desc, eq, like, or } from 'drizzle-orm'
import { AdminMeResponse, Password, StaffRole, Ulid, VerifyStatus } from '@pc/contract'
import { db } from '../../db/client.js'
import {
  customerInmates,
  customers,
  inmates,
  prisons,
  staff,
  zones
} from '../../db/schema/index.js'
import { writeAudit } from '../../lib/audit.js'
import { requestContext } from '../../lib/auth/session.js'
import { customerRealm, staffRealm } from '../../lib/auth/realms.js'
import { badRequest, conflict, notFound, unauthorized } from '../../lib/errors.js'
import { generateOneTimePassword, hashPassword } from '../../lib/password.js'
import { bearerAuth, commonErrors, jsonBody, jsonRes } from '../../lib/openapi.js'
import { defaultHook } from '../../lib/hook.js'
import { notify } from '../../lib/notify/index.js'
import { now } from '../../lib/time.js'
import { blockUntilPasswordChanged, requireRole, requireStaff } from '../../middleware/auth.js'
import {
  assertInScope,
  prisonScope,
  resolvePrisonId,
  scopeFilter
} from '../../middleware/prison-scope.js'
import type { AppEnv } from '../../types.js'

const CustomerRow = z.object({
  id: Ulid,
  username: z.string(),
  fullName: z.string(),
  phone: z.string(),
  isBlocked: z.boolean(),
  mustChangePassword: z.boolean(),
  lockedUntil: z.number().nullable(),
  lastLoginAt: z.number().nullable(),
  linkCount: z.number().int(),
  createdAt: z.number()
})

const StaffRow = z.object({
  id: Ulid,
  username: z.string(),
  fullName: z.string(),
  email: z.string().nullable(),
  role: StaffRole,
  prisonId: Ulid.nullable(),
  prisonName: z.string().nullable(),
  isActive: z.boolean(),
  mustChangePassword: z.boolean(),
  lockedUntil: z.number().nullable(),
  lastLoginAt: z.number().nullable(),
  createdAt: z.number()
})

/** Shown to the staff member once. Never stored, never retrievable again. */
const OneTimePassword = z.object({
  oneTimePassword: z.string(),
  mustChangePassword: z.literal(true)
})

function staffRowView(row: typeof staff.$inferSelect) {
  const prison = row.prisonId
    ? db().select().from(prisons).where(eq(prisons.id, row.prisonId)).get()
    : null
  return {
    id: row.id,
    username: row.username,
    fullName: row.fullName,
    email: row.email,
    role: row.role,
    prisonId: row.prisonId,
    prisonName: prison?.nameTh ?? null,
    isActive: row.isActive,
    mustChangePassword: row.mustChangePassword,
    lockedUntil: row.lockedUntil,
    lastLoginAt: row.lastLoginAt,
    createdAt: row.createdAt
  }
}

export function createAdminRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireStaff)
  // Staff accounts are created with must_change_password = 1; the dashboard is
  // unreachable until that is done.
  app.use('*', blockUntilPasswordChanged)

  /* ── who am I ──────────────────────────────────────────────────────── */

  app.openapi(
    createRoute({
      method: 'get',
      path: '/me',
      tags: ['admin'],
      summary: 'ข้อมูลเจ้าหน้าที่ที่เข้าสู่ระบบ',
      security: bearerAuth,
      responses: { 200: jsonRes(AdminMeResponse, 'ข้อมูลเจ้าหน้าที่'), ...commonErrors }
    }),
    (c) => {
      const principal = c.get('staff')!
      const row = db().select().from(staff).where(eq(staff.id, principal.id)).get()
      if (!row) throw unauthorized()
      const view = staffRowView(row)
      return c.json(
        {
          id: view.id,
          username: view.username,
          fullName: view.fullName,
          email: view.email,
          role: view.role,
          prisonId: view.prisonId,
          prisonName: view.prisonName,
          mustChangePassword: view.mustChangePassword
        },
        200
      )
    }
  )

  /* ── customers ─────────────────────────────────────────────────────── */

  app.openapi(
    createRoute({
      method: 'get',
      path: '/customers',
      tags: ['admin:customers'],
      summary: 'ค้นหาบัญชีญาติผู้ต้องขัง',
      security: bearerAuth,
      request: {
        query: z.object({
          q: z.string().trim().max(60).optional(),
          limit: z.coerce.number().int().min(1).max(100).default(20),
          offset: z.coerce.number().int().min(0).default(0)
        })
      },
      responses: {
        200: jsonRes(
          z.object({ items: z.array(CustomerRow), total: z.number().int() }),
          'รายชื่อบัญชีญาติ'
        ),
        ...commonErrors
      }
    }),
    (c) => {
      const { q, limit, offset } = c.req.valid('query')
      const filter = q
        ? or(like(customers.fullName, `%${q}%`), like(customers.username, `%${q}%`))
        : undefined

      const items = db()
        .select({
          id: customers.id,
          username: customers.username,
          fullName: customers.fullName,
          phone: customers.phone,
          isBlocked: customers.isBlocked,
          mustChangePassword: customers.mustChangePassword,
          lockedUntil: customers.lockedUntil,
          lastLoginAt: customers.lastLoginAt,
          createdAt: customers.createdAt,
          linkCount: count(customerInmates.id)
        })
        .from(customers)
        .leftJoin(customerInmates, eq(customerInmates.customerId, customers.id))
        .where(filter)
        .groupBy(customers.id)
        .orderBy(desc(customers.createdAt))
        .limit(limit)
        .offset(offset)
        .all()

      const total = db().select({ n: count() }).from(customers).where(filter).get()?.n ?? 0

      return c.json({ items, total }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/customers/{id}/reset-password',
      tags: ['admin:customers'],
      summary: 'ตั้งรหัสผ่านชั่วคราวให้ญาติผู้ต้องขัง',
      description:
        'การรีเซ็ตรหัสผ่านในเฟสแรกทำโดยเจ้าหน้าที่เท่านั้น ระบบออกรหัสผ่านครั้งเดียวและบังคับเปลี่ยนเมื่อเข้าใช้',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(OneTimePassword, 'รหัสผ่านชั่วคราว'), ...commonErrors }
    }),
    async (c) => {
      const actor = c.get('staff')!
      const { id } = c.req.valid('param')
      const target = db().select().from(customers).where(eq(customers.id, id)).get()
      if (!target) throw notFound('ไม่พบบัญชีผู้ใช้')

      const otp = generateOneTimePassword()
      const at = now()
      customerRealm.setPassword(db(), id, await hashPassword(otp), true, at)
      customerRealm.revokeAllForUser(db(), id, at)

      const ctx = requestContext(c)
      writeAudit({
        actorType: 'staff',
        actorId: actor.id,
        action: 'customer.reset_password',
        entity: 'customer',
        entityId: id,
        after: { mustChangePassword: true },
        ip: ctx.ip,
        userAgent: ctx.userAgent
      })
      await notify({
        audience: 'customer',
        recipientId: id,
        kind: 'account.password_reset',
        title: 'รหัสผ่านถูกตั้งใหม่โดยเจ้าหน้าที่',
        body: 'กรุณาเข้าสู่ระบบด้วยรหัสผ่านชั่วคราวที่ได้รับ แล้วตั้งรหัสผ่านใหม่ทันที'
      })

      return c.json({ oneTimePassword: otp, mustChangePassword: true as const }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/customers/{id}/unlock',
      tags: ['admin:customers'],
      summary: 'ปลดล็อกบัญชีที่ถูกล็อกจากการเข้าสู่ระบบผิดหลายครั้ง',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }) },
      responses: {
        200: jsonRes(z.object({ id: Ulid, lockedUntil: z.null() }), 'ปลดล็อกแล้ว'),
        ...commonErrors
      }
    }),
    (c) => {
      const actor = c.get('staff')!
      const { id } = c.req.valid('param')
      const target = db().select().from(customers).where(eq(customers.id, id)).get()
      if (!target) throw notFound('ไม่พบบัญชีผู้ใช้')

      db()
        .update(customers)
        .set({ failedAttempts: 0, lockedUntil: null })
        .where(eq(customers.id, id))
        .run()

      writeAudit({
        actorType: 'staff',
        actorId: actor.id,
        action: 'customer.unlock',
        entity: 'customer',
        entityId: id,
        before: { lockedUntil: target.lockedUntil, failedAttempts: target.failedAttempts },
        after: { lockedUntil: null, failedAttempts: 0 }
      })
      return c.json({ id, lockedUntil: null }, 200)
    }
  )

  const LinkRow = z.object({
    id: Ulid,
    customerId: Ulid,
    customerName: z.string(),
    customerPhone: z.string(),
    inmateId: Ulid,
    inmateCode: z.string(),
    inmateName: z.string(),
    prisonId: Ulid,
    prisonName: z.string(),
    zoneName: z.string().nullable(),
    relationship: z.string().nullable(),
    verifyStatus: VerifyStatus,
    requestedAt: z.number()
  })

  app.openapi(
    createRoute({
      method: 'get',
      path: '/customer-inmates',
      tags: ['admin:customers'],
      summary: 'คิวคำขอผูกบัญชีญาติกับผู้ต้องขัง',
      description: 'จำกัดขอบเขตตามเรือนจำของเจ้าหน้าที่โดยอัตโนมัติ',
      security: bearerAuth,
      request: {
        query: z.object({
          status: VerifyStatus.default('pending'),
          limit: z.coerce.number().int().min(1).max(100).default(50)
        })
      },
      responses: {
        200: jsonRes(z.object({ items: z.array(LinkRow) }), 'คำขอผูกบัญชี'),
        ...commonErrors
      }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const { status, limit } = c.req.valid('query')

      const items = db()
        .select({
          id: customerInmates.id,
          customerId: customers.id,
          customerName: customers.fullName,
          customerPhone: customers.phone,
          inmateId: inmates.id,
          inmateCode: inmates.inmateCode,
          inmateName: inmates.fullName,
          prisonId: prisons.id,
          prisonName: prisons.nameTh,
          zoneName: zones.name,
          relationship: customerInmates.relationship,
          verifyStatus: customerInmates.verifyStatus,
          requestedAt: customerInmates.createdAt
        })
        .from(customerInmates)
        .innerJoin(customers, eq(customerInmates.customerId, customers.id))
        .innerJoin(inmates, eq(customerInmates.inmateId, inmates.id))
        .innerJoin(prisons, eq(inmates.prisonId, prisons.id))
        .leftJoin(zones, eq(inmates.zoneId, zones.id))
        .where(and(eq(customerInmates.verifyStatus, status), scopeFilter(scope, inmates.prisonId)))
        .orderBy(desc(customerInmates.createdAt))
        .limit(limit)
        .all()

      return c.json({ items }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/customer-inmates/{id}/verify',
      tags: ['admin:customers'],
      summary: 'อนุมัติหรือปฏิเสธการผูกบัญชีกับผู้ต้องขัง',
      description: 'ประตูของทุกอย่างที่เกี่ยวกับเงิน จดหมาย และการเยี่ยม',
      security: bearerAuth,
      request: {
        params: z.object({ id: Ulid }),
        body: jsonBody(
          z.object({
            status: z.enum(['verified', 'rejected']),
            reason: z.string().trim().max(200).optional()
          })
        )
      },
      responses: {
        200: jsonRes(
          z.object({ id: Ulid, verifyStatus: VerifyStatus, verifiedAt: z.number().nullable() }),
          'ผลการตรวจสอบ'
        ),
        ...commonErrors
      }
    }),
    async (c) => {
      const actor = c.get('staff')!
      const scope = prisonScope(actor)
      const { id } = c.req.valid('param')
      const { status, reason } = c.req.valid('json')

      const row = db()
        .select({
          linkId: customerInmates.id,
          customerId: customerInmates.customerId,
          verifyStatus: customerInmates.verifyStatus,
          prisonId: inmates.prisonId
        })
        .from(customerInmates)
        .innerJoin(inmates, eq(customerInmates.inmateId, inmates.id))
        .where(eq(customerInmates.id, id))
        .get()
      if (!row) throw notFound('ไม่พบคำขอผูกบัญชี')
      assertInScope(scope, row.prisonId)

      const at = now()
      db()
        .update(customerInmates)
        .set({
          verifyStatus: status,
          verifiedAt: status === 'verified' ? at : null,
          verifiedBy: actor.id,
          rejectReason: status === 'rejected' ? (reason ?? null) : null
        })
        .where(eq(customerInmates.id, id))
        .run()

      writeAudit({
        actorType: 'staff',
        actorId: actor.id,
        action: `customer_inmate.${status}`,
        entity: 'customer_inmate',
        entityId: id,
        prisonId: row.prisonId,
        before: { verifyStatus: row.verifyStatus },
        after: { verifyStatus: status, reason }
      })

      if (status === 'verified') {
        await notify({
          audience: 'customer',
          recipientId: row.customerId,
          kind: 'account.link_verified',
          title: 'ยืนยันความสัมพันธ์เรียบร้อย',
          body: 'ตอนนี้คุณสามารถสั่งซื้อสินค้า ฝากเงิน ส่งจดหมาย และจองเยี่ยมได้แล้ว'
        })
      }

      return c.json(
        { id, verifyStatus: status, verifiedAt: status === 'verified' ? at : null },
        200
      )
    }
  )

  /* ── staff accounts (super_admin only) ─────────────────────────────── */

  const staffAdmin = new OpenAPIHono<AppEnv>({ defaultHook })
  staffAdmin.use('*', requireRole('super_admin'))

  staffAdmin.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['admin:staff'],
      summary: 'รายชื่อเจ้าหน้าที่',
      security: bearerAuth,
      request: { query: z.object({ prisonId: Ulid.optional() }) },
      responses: {
        200: jsonRes(z.object({ items: z.array(StaffRow) }), 'รายชื่อเจ้าหน้าที่'),
        ...commonErrors
      }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const prisonId = resolvePrisonId(scope, c.req.valid('query').prisonId ?? null)
      const items = db()
        .select()
        .from(staff)
        .where(prisonId ? eq(staff.prisonId, prisonId) : scopeFilter(scope, staff.prisonId))
        .orderBy(desc(staff.createdAt))
        .all()
        .map(staffRowView)
      return c.json({ items }, 200)
    }
  )

  staffAdmin.openapi(
    createRoute({
      method: 'post',
      path: '/',
      tags: ['admin:staff'],
      summary: 'สร้างบัญชีเจ้าหน้าที่',
      description:
        'ชื่อผู้ใช้ถูกกำหนดให้ ไม่ใช่ผู้ใช้เลือกเอง และบังคับเปลี่ยนรหัสผ่านเมื่อเข้าใช้ครั้งแรกเสมอ',
      security: bearerAuth,
      request: {
        body: jsonBody(
          z.object({
            username: z
              .string()
              .trim()
              .min(3)
              .max(60)
              .regex(/^[A-Za-z0-9._-]+$/, 'ใช้ได้เฉพาะ a-z 0-9 . _ -'),
            fullName: z.string().trim().min(2).max(120),
            email: z.email().optional(),
            role: StaffRole,
            prisonId: Ulid.nullable().optional(),
            password: Password.optional()
          })
        )
      },
      responses: {
        201: jsonRes(StaffRow.extend({ oneTimePassword: z.string() }), 'สร้างบัญชีแล้ว'),
        ...commonErrors
      }
    }),
    async (c) => {
      const actor = c.get('staff')!
      const input = c.req.valid('json')

      if (input.role === 'super_admin' && input.prisonId) {
        throw badRequest('super_admin ต้องไม่ผูกกับเรือนจำใดเรือนจำหนึ่ง')
      }
      if (input.role !== 'super_admin' && !input.prisonId) {
        throw badRequest('บทบาทนี้ต้องระบุเรือนจำ', { prisonId: ['ต้องระบุเรือนจำ'] })
      }
      if (
        db().select({ id: staff.id }).from(staff).where(eq(staff.username, input.username)).get()
      ) {
        throw conflict('ชื่อผู้ใช้นี้ถูกใช้แล้ว')
      }
      if (
        input.prisonId &&
        !db().select({ id: prisons.id }).from(prisons).where(eq(prisons.id, input.prisonId)).get()
      ) {
        throw notFound('ไม่พบเรือนจำ')
      }

      const otp = input.password ?? generateOneTimePassword()
      const row = db()
        .insert(staff)
        .values({
          username: input.username,
          fullName: input.fullName,
          email: input.email ?? null,
          role: input.role,
          prisonId: input.prisonId ?? null,
          passwordHash: await hashPassword(otp),
          mustChangePassword: true
        })
        .returning()
        .get()

      writeAudit({
        actorType: 'staff',
        actorId: actor.id,
        action: 'staff.create',
        entity: 'staff',
        entityId: row.id,
        prisonId: row.prisonId,
        after: { username: row.username, role: row.role, prisonId: row.prisonId }
      })

      return c.json({ ...staffRowView(row), oneTimePassword: otp }, 201)
    }
  )

  staffAdmin.openapi(
    createRoute({
      method: 'post',
      path: '/{id}/reset-password',
      tags: ['admin:staff'],
      summary: 'ตั้งรหัสผ่านชั่วคราวให้เจ้าหน้าที่',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(OneTimePassword, 'รหัสผ่านชั่วคราว'), ...commonErrors }
    }),
    async (c) => {
      const actor = c.get('staff')!
      const { id } = c.req.valid('param')
      if (!db().select({ id: staff.id }).from(staff).where(eq(staff.id, id)).get()) {
        throw notFound('ไม่พบบัญชีเจ้าหน้าที่')
      }

      const otp = generateOneTimePassword()
      const at = now()
      staffRealm.setPassword(db(), id, await hashPassword(otp), true, at)
      staffRealm.revokeAllForUser(db(), id, at)

      writeAudit({
        actorType: 'staff',
        actorId: actor.id,
        action: 'staff.reset_password',
        entity: 'staff',
        entityId: id
      })
      return c.json({ oneTimePassword: otp, mustChangePassword: true as const }, 200)
    }
  )

  staffAdmin.openapi(
    createRoute({
      method: 'patch',
      path: '/{id}',
      tags: ['admin:staff'],
      summary: 'แก้ไขบัญชีเจ้าหน้าที่',
      security: bearerAuth,
      request: {
        params: z.object({ id: Ulid }),
        body: jsonBody(
          z.object({
            fullName: z.string().trim().min(2).max(120).optional(),
            email: z.email().nullable().optional(),
            role: StaffRole.optional(),
            prisonId: Ulid.nullable().optional(),
            isActive: z.boolean().optional()
          })
        )
      },
      responses: { 200: jsonRes(StaffRow, 'อัปเดตแล้ว'), ...commonErrors }
    }),
    (c) => {
      const actor = c.get('staff')!
      const { id } = c.req.valid('param')
      const input = c.req.valid('json')
      const before = db().select().from(staff).where(eq(staff.id, id)).get()
      if (!before) throw notFound('ไม่พบบัญชีเจ้าหน้าที่')

      const role = input.role ?? before.role
      const prisonId = input.prisonId !== undefined ? input.prisonId : before.prisonId
      if (role === 'super_admin' && prisonId) throw badRequest('super_admin ต้องไม่ผูกกับเรือนจำ')
      if (role !== 'super_admin' && !prisonId) throw badRequest('บทบาทนี้ต้องระบุเรือนจำ')

      const row = db()
        .update(staff)
        .set({
          ...(input.fullName ? { fullName: input.fullName } : {}),
          ...(input.email !== undefined ? { email: input.email } : {}),
          role,
          prisonId,
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {})
        })
        .where(eq(staff.id, id))
        .returning()
        .get()

      // Deactivation must bite immediately, not when the access token expires.
      if (input.isActive === false) staffRealm.revokeAllForUser(db(), id, now())

      writeAudit({
        actorType: 'staff',
        actorId: actor.id,
        action: 'staff.update',
        entity: 'staff',
        entityId: id,
        prisonId: row.prisonId,
        before,
        after: row
      })

      return c.json(staffRowView(row), 200)
    }
  )

  app.route('/staff', staffAdmin)
  return app
}
