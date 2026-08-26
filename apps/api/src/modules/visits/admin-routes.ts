import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq, gte, like, lte, or, sql } from 'drizzle-orm'
import {
  CloseVisitDatesInput,
  CreateVisitRoundInput,
  CreateVisitScheduleDayInput,
  GenerateVisitScheduleInput,
  GenerateVisitScheduleResult,
  IsoDate,
  PageQuery,
  Ulid,
  UpdateVisitBookingStatusInput,
  UpdateVisitRoundInput,
  UpdateVisitScheduleDayInput,
  UpsertVisitTemplateInput,
  VisitBookingDetail,
  VisitBookingStatus,
  VisitBookingSummary,
  VisitRound,
  VisitScheduleDay,
  VisitScheduleGrid,
  VisitSummaryTotals,
  VisitTemplateCell,
  pageOf
} from '@pc/contract'
import { db } from '../../db/client.js'
import { visitBookings } from '../../db/schema/index.js'
import { badRequest } from '../../lib/errors.js'
import { decodeCursor, paginate } from '../../lib/cursor.js'
import { bearerAuth, commonErrors, jsonBody, jsonRes } from '../../lib/openapi.js'
import { defaultHook } from '../../lib/hook.js'
import { requestContext } from '../../lib/auth/session.js'
import { addDays, bangkokDate } from '../../lib/time.js'
import { blockUntilPasswordChanged, requireRole, requireStaff } from '../../middleware/auth.js'
import {
  assertInScope,
  prisonScope,
  resolvePrisonId,
  scopeFilter
} from '../../middleware/prison-scope.js'
import type { AppEnv } from '../../types.js'
import {
  bookingDetail,
  bookingQuery,
  closeDates,
  createRound,
  createScheduleDay,
  deleteRound,
  deleteScheduleDay,
  deleteTemplate,
  listRounds,
  listTemplates,
  materializeSchedule,
  roundView,
  scheduleDayView,
  scheduleGrid,
  setBookingStatus,
  templatePrisonId,
  updateRound,
  updateScheduleDay,
  upsertTemplate,
  visitTotals
} from './service.js'

/**
 * The schedule is the facility's own decision (§4.6), so building it is a
 * prison_admin job. `zone_staff` works the gate: it reads the grid and the
 * booking list, and checks people in.
 */
const canSchedule = requireRole('super_admin', 'prison_admin')
const canOperate = requireRole('super_admin', 'prison_admin', 'zone_staff')

/** super_admin must say which prison it is editing — there is no "all" schedule. */
function requirePrison(scope: ReturnType<typeof prisonScope>, requested?: string | null): string {
  const id = resolvePrisonId(scope, requested ?? null)
  if (!id) throw badRequest('ต้องระบุเรือนจำ (prisonId)')
  return id
}

export function createAdminVisitRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireStaff)
  app.use('*', blockUntilPasswordChanged)

  /* ── rounds ────────────────────────────────────────────────────────── */

  app.openapi(
    createRoute({
      method: 'get',
      path: '/visit-rounds',
      tags: ['admin:visits'],
      summary: 'รอบเยี่ยม',
      security: bearerAuth,
      request: {
        query: z.object({
          prisonId: Ulid.optional(),
          includeInactive: z.coerce.boolean().optional()
        })
      },
      responses: {
        200: jsonRes(z.object({ items: z.array(VisitRound) }), 'รอบเยี่ยม'),
        ...commonErrors
      }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const q = c.req.valid('query')
      const prisonId = resolvePrisonId(scope, q.prisonId ?? null)
      return c.json(
        { items: listRounds(prisonId, { includeInactive: q.includeInactive }, db()) },
        200
      )
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/visit-rounds',
      tags: ['admin:visits'],
      summary: 'เพิ่มรอบเยี่ยม',
      description: 'จำนวนรอบต่อวันต่างกันไปในแต่ละเรือนจำ จึงเป็นข้อมูลรายเรือนจำ',
      security: bearerAuth,
      middleware: [canSchedule] as const,
      request: { body: jsonBody(CreateVisitRoundInput) },
      responses: { 201: jsonRes(VisitRound, 'รอบเยี่ยม'), ...commonErrors }
    }),
    (c) => {
      const staff = c.get('staff')!
      const scope = prisonScope(staff)
      const input = c.req.valid('json')
      const prisonId = requirePrison(scope, input.prisonId)
      return c.json(createRound(prisonId, input, staff.id, requestContext(c)), 201)
    }
  )

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/visit-rounds/{id}',
      tags: ['admin:visits'],
      summary: 'แก้ไขรอบเยี่ยม',
      security: bearerAuth,
      middleware: [canSchedule] as const,
      request: { params: z.object({ id: Ulid }), body: jsonBody(UpdateVisitRoundInput) },
      responses: { 200: jsonRes(VisitRound, 'รอบเยี่ยม'), ...commonErrors }
    }),
    (c) => {
      const staff = c.get('staff')!
      const id = c.req.valid('param').id
      assertInScope(prisonScope(staff), roundView(id).prisonId)
      return c.json(updateRound(id, c.req.valid('json'), staff.id, requestContext(c)), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/visit-rounds/{id}',
      tags: ['admin:visits'],
      summary: 'ลบรอบเยี่ยมที่ยังไม่เคยใช้',
      security: bearerAuth,
      middleware: [canSchedule] as const,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(z.object({ ok: z.literal(true) }), 'ลบแล้ว'), ...commonErrors }
    }),
    (c) => {
      const staff = c.get('staff')!
      const id = c.req.valid('param').id
      assertInScope(prisonScope(staff), roundView(id).prisonId)
      deleteRound(id, staff.id)
      return c.json({ ok: true as const }, 200)
    }
  )

  /* ── weekly template ───────────────────────────────────────────────── */

  app.openapi(
    createRoute({
      method: 'get',
      path: '/visit-templates',
      tags: ['admin:visits'],
      summary: 'แม่แบบตารางรายสัปดาห์',
      description: 'ตารางหน้า 12 ในรูปแบบแม่แบบ — เป็นจุดตั้งต้น ไม่ใช่ตัวแบบของการจอง',
      security: bearerAuth,
      request: { query: z.object({ prisonId: Ulid.optional() }) },
      responses: {
        200: jsonRes(z.object({ items: z.array(VisitTemplateCell) }), 'แม่แบบ'),
        ...commonErrors
      }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const prisonId = resolvePrisonId(scope, c.req.valid('query').prisonId ?? null)
      return c.json({ items: listTemplates(prisonId, db()) }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'put',
      path: '/visit-templates',
      tags: ['admin:visits'],
      summary: 'ตั้งค่าช่องหนึ่งของแม่แบบ',
      security: bearerAuth,
      middleware: [canSchedule] as const,
      request: { body: jsonBody(UpsertVisitTemplateInput) },
      responses: { 200: jsonRes(VisitTemplateCell, 'แม่แบบ'), ...commonErrors }
    }),
    (c) => {
      const staff = c.get('staff')!
      const input = c.req.valid('json')
      const prisonId = requirePrison(prisonScope(staff), input.prisonId)
      return c.json(upsertTemplate(prisonId, input, staff.id, requestContext(c)), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/visit-templates/{id}',
      tags: ['admin:visits'],
      summary: 'ลบช่องของแม่แบบ',
      security: bearerAuth,
      middleware: [canSchedule] as const,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(z.object({ ok: z.literal(true) }), 'ลบแล้ว'), ...commonErrors }
    }),
    (c) => {
      const staff = c.get('staff')!
      const id = c.req.valid('param').id
      assertInScope(prisonScope(staff), templatePrisonId(id))
      deleteTemplate(id, staff.id)
      return c.json({ ok: true as const }, 200)
    }
  )

  /* ── the week grid ─────────────────────────────────────────────────── */

  app.openapi(
    createRoute({
      method: 'get',
      path: '/visit-schedule',
      tags: ['admin:visits'],
      summary: 'ตารางเยี่ยมแบบสัปดาห์',
      description: 'รอบอยู่แนวตั้ง วันที่อยู่แนวนอน แต่ละช่องคือ แดน + จอง/ความจุ',
      security: bearerAuth,
      request: {
        query: z.object({
          prisonId: Ulid.optional(),
          from: IsoDate.optional(),
          to: IsoDate.optional()
        })
      },
      responses: { 200: jsonRes(VisitScheduleGrid, 'ตารางเยี่ยม'), ...commonErrors }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const q = c.req.valid('query')
      const prisonId = resolvePrisonId(scope, q.prisonId ?? null)
      const from = q.from ?? bangkokDate()
      const to = q.to ?? addDays(from, 6)
      if (to < from) throw badRequest('ช่วงวันที่ไม่ถูกต้อง')
      return c.json(scheduleGrid(prisonId, from, to, db()), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/visit-schedule',
      tags: ['admin:visits'],
      summary: 'เพิ่มช่องเวลาเยี่ยมด้วยมือ',
      description: 'ช่องที่คนกรอกจะเป็น source=manual และงาน materialize จะไม่แตะอีกเลย',
      security: bearerAuth,
      middleware: [canSchedule] as const,
      request: { body: jsonBody(CreateVisitScheduleDayInput) },
      responses: { 201: jsonRes(VisitScheduleDay, 'ช่องเวลาเยี่ยม'), ...commonErrors }
    }),
    (c) => {
      const staff = c.get('staff')!
      const input = c.req.valid('json')
      const prisonId = requirePrison(prisonScope(staff), input.prisonId)
      return c.json(createScheduleDay(prisonId, input, staff.id, requestContext(c)), 201)
    }
  )

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/visit-schedule/{id}',
      tags: ['admin:visits'],
      summary: 'แก้ไขช่องเวลาเยี่ยม',
      description: 'เปลี่ยนแดน เพิ่มความจุ หรือปิดช่อง — การแก้ด้วยมือมีผลถาวร',
      security: bearerAuth,
      middleware: [canSchedule] as const,
      request: { params: z.object({ id: Ulid }), body: jsonBody(UpdateVisitScheduleDayInput) },
      responses: { 200: jsonRes(VisitScheduleDay, 'ช่องเวลาเยี่ยม'), ...commonErrors }
    }),
    (c) => {
      const staff = c.get('staff')!
      const id = c.req.valid('param').id
      assertInScope(prisonScope(staff), scheduleDayView(id).prisonId)
      return c.json(updateScheduleDay(id, c.req.valid('json'), staff.id, requestContext(c)), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/visit-schedule/{id}',
      tags: ['admin:visits'],
      summary: 'ลบช่องเวลาที่ยังไม่มีการจอง',
      security: bearerAuth,
      middleware: [canSchedule] as const,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(z.object({ ok: z.literal(true) }), 'ลบแล้ว'), ...commonErrors }
    }),
    (c) => {
      const staff = c.get('staff')!
      const id = c.req.valid('param').id
      assertInScope(prisonScope(staff), scheduleDayView(id).prisonId)
      deleteScheduleDay(id, staff.id)
      return c.json({ ok: true as const }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/visit-schedule/generate',
      tags: ['admin:visits'],
      summary: 'สร้างตารางล่วงหน้าจากแม่แบบ',
      description: 'ทำซ้ำได้ปลอดภัย — ช่องที่มีอยู่แล้วจะไม่ถูกแตะ ไม่ว่าจะมาจากแม่แบบหรือจากคน',
      security: bearerAuth,
      middleware: [canSchedule] as const,
      request: { body: jsonBody(GenerateVisitScheduleInput) },
      responses: { 200: jsonRes(GenerateVisitScheduleResult, 'ผลการสร้าง'), ...commonErrors }
    }),
    (c) => {
      const staff = c.get('staff')!
      const input = c.req.valid('json')
      const prisonId = requirePrison(prisonScope(staff), input.prisonId)
      return c.json(
        materializeSchedule(prisonId, { weeks: input.weeks, from: input.from }, db()),
        200
      )
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/visit-schedule/close',
      tags: ['admin:visits'],
      summary: 'ปิด (หรือเปิด) การเยี่ยมทั้งช่วงวัน',
      description: 'วันหยุด หรือช่วงล็อกดาวน์ — ปิดทุกช่องในช่วงวันที่ที่ระบุ',
      security: bearerAuth,
      middleware: [canSchedule] as const,
      request: { body: jsonBody(CloseVisitDatesInput) },
      responses: {
        200: jsonRes(z.object({ affected: z.number().int() }), 'จำนวนช่องที่เปลี่ยน'),
        ...commonErrors
      }
    }),
    (c) => {
      const staff = c.get('staff')!
      const input = c.req.valid('json')
      const prisonId = requirePrison(prisonScope(staff), input.prisonId)
      return c.json(closeDates(prisonId, input, staff.id, requestContext(c)), 200)
    }
  )

  /* ── bookings / the gate desk ──────────────────────────────────────── */

  app.openapi(
    createRoute({
      method: 'get',
      path: '/visits/summary',
      tags: ['admin:visits'],
      summary: 'สรุปการเยี่ยมตามช่วงวัน',
      security: bearerAuth,
      request: {
        query: z.object({
          prisonId: Ulid.optional(),
          from: IsoDate.optional(),
          to: IsoDate.optional()
        })
      },
      responses: { 200: jsonRes(VisitSummaryTotals, 'สรุป'), ...commonErrors }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const q = c.req.valid('query')
      const prisonId = resolvePrisonId(scope, q.prisonId ?? null)
      return c.json(visitTotals(prisonId, { from: q.from, to: q.to }, db()), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/visits',
      tags: ['admin:visits'],
      summary: 'รายการจองเยี่ยม',
      description: 'ค่าเริ่มต้นคือรายการของวันนี้ เรียงตามรอบ — นี่คือใบรายชื่อหน้าประตู',
      security: bearerAuth,
      request: {
        query: PageQuery.extend({
          prisonId: Ulid.optional(),
          zoneId: Ulid.optional(),
          status: VisitBookingStatus.optional(),
          date: IsoDate.optional(),
          from: IsoDate.optional(),
          to: IsoDate.optional(),
          /** เลขที่จอง ชื่อ/รหัสผู้ต้องขัง หรือชื่อผู้เยี่ยม */
          q: z.string().max(80).optional()
        })
      },
      responses: { 200: jsonRes(pageOf(VisitBookingSummary), 'การจองเยี่ยม'), ...commonErrors }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const q = c.req.valid('query')
      const requested = resolvePrisonId(scope, q.prisonId ?? null)
      const after = decodeCursor(q.cursor)
      const from = q.date ?? q.from
      const to = q.date ?? q.to

      const rows = bookingQuery(db())
        .where(
          and(
            requested
              ? eq(visitBookings.prisonId, requested)
              : scopeFilter(scope, visitBookings.prisonId),
            q.zoneId ? eq(visitBookings.zoneId, q.zoneId) : undefined,
            q.status ? eq(visitBookings.status, q.status) : undefined,
            from ? gte(visitBookings.visitDate, from) : undefined,
            to ? lte(visitBookings.visitDate, to) : undefined,
            q.q
              ? or(
                  like(visitBookings.bookingNo, `%${q.q}%`),
                  like(visitBookings.inmateNameSnapshot, `%${q.q}%`),
                  like(visitBookings.inmateCodeSnapshot, `%${q.q}%`),
                  like(visitBookings.visitorName, `%${q.q}%`)
                )
              : undefined,
            after
              ? sql`(${visitBookings.startsAt}, ${visitBookings.id}) < (${after[0]}, ${after[1]})`
              : undefined
          )
        )
        .orderBy(desc(visitBookings.startsAt), desc(visitBookings.id))
        .limit(q.limit + 1)
        .all()

      return c.json(paginate(rows, q.limit, (r) => [r.startsAt, r.id]), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/visits/{id}',
      tags: ['admin:visits'],
      summary: 'รายละเอียดการจองเยี่ยม',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(VisitBookingDetail, 'การจองเยี่ยม'), ...commonErrors }
    }),
    (c) => {
      const detail = bookingDetail(c.req.valid('param').id)
      assertInScope(prisonScope(c.get('staff')), detail.prisonId)
      return c.json(detail, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/visits/{id}/status',
      tags: ['admin:visits'],
      summary: 'ยืนยัน / เช็คอิน / ไม่มาตามนัด / ยกเลิก',
      description: '“ไม่มาตามนัด” ไม่คืนที่นั่ง — รอบผ่านไปแล้ว มันคือข้อเท็จจริงการเข้าเยี่ยม',
      security: bearerAuth,
      middleware: [canOperate] as const,
      request: {
        params: z.object({ id: Ulid }),
        body: jsonBody(UpdateVisitBookingStatusInput)
      },
      responses: { 200: jsonRes(VisitBookingDetail, 'การจองเยี่ยม'), ...commonErrors }
    }),
    async (c) => {
      const staff = c.get('staff')!
      const id = c.req.valid('param').id
      assertInScope(prisonScope(staff), bookingDetail(id).prisonId)
      return c.json(
        await setBookingStatus(staff.id, id, c.req.valid('json'), requestContext(c)),
        200
      )
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/visits/{id}/check-in',
      tags: ['admin:visits'],
      summary: 'เช็คอินหน้าประตู',
      security: bearerAuth,
      middleware: [canOperate] as const,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(VisitBookingDetail, 'เช็คอินแล้ว'), ...commonErrors }
    }),
    async (c) => {
      const staff = c.get('staff')!
      const id = c.req.valid('param').id
      assertInScope(prisonScope(staff), bookingDetail(id).prisonId)
      return c.json(
        await setBookingStatus(staff.id, id, { status: 'checked_in' }, requestContext(c)),
        200
      )
    }
  )

  return app
}
