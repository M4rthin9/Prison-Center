import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq, gte, like, lte, or, sql } from 'drizzle-orm'
import {
  DepositCard,
  DepositCardStatus,
  DepositDetail,
  DepositStatus,
  DepositSummary,
  DepositSummaryTotals,
  PageQuery,
  ReviewDepositCardInput,
  ReviewDepositInput,
  Ulid,
  pageOf
} from '@pc/contract'
import { db } from '../../db/client.js'
import { depositCards, deposits } from '../../db/schema/index.js'
import { notFound } from '../../lib/errors.js'
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
  depositCardQuery,
  depositDetail,
  depositSummaryQuery,
  depositTotals,
  paymentStatusesFor,
  reviewDeposit,
  reviewDepositCard
} from './service.js'

/** Money movement: the same two roles that verify payments review deposits. */
const canReview = requireRole('super_admin', 'prison_admin', 'finance')

export function createAdminDepositRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireStaff)
  app.use('*', blockUntilPasswordChanged)

  /* ── the review queue (p.7) ────────────────────────────────────────── */

  app.openapi(
    createRoute({
      method: 'get',
      path: '/deposits',
      tags: ['admin:deposits'],
      summary: 'คิวตรวจสอบการฝากเงิน',
      security: bearerAuth,
      request: {
        query: PageQuery.extend({
          prisonId: Ulid.optional(),
          status: DepositStatus.optional(),
          /** เลขที่รายการ ชื่อผู้ต้องขัง รหัสผู้ต้องขัง หรือชื่อผู้ฝาก */
          q: z.string().max(80).optional(),
          from: z.coerce.number().int().optional(),
          to: z.coerce.number().int().optional()
        })
      },
      responses: { 200: jsonRes(pageOf(DepositSummary), 'รายการฝากเงิน'), ...commonErrors }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const { cursor, limit, prisonId, status, q, from, to } = c.req.valid('query')
      const requested = resolvePrisonId(scope, prisonId ?? null)
      const after = decodeCursor(cursor)

      const rows = depositSummaryQuery(db())
        .where(
          and(
            requested ? eq(deposits.prisonId, requested) : scopeFilter(scope, deposits.prisonId),
            status ? eq(deposits.status, status) : undefined,
            from ? gte(deposits.createdAt, from) : undefined,
            to ? lte(deposits.createdAt, to) : undefined,
            q
              ? or(
                  like(deposits.depositNo, `%${q}%`),
                  like(deposits.inmateNameSnapshot, `%${q}%`),
                  like(deposits.inmateCodeSnapshot, `%${q}%`),
                  like(deposits.depositorName, `%${q}%`)
                )
              : undefined,
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
      method: 'get',
      path: '/deposits/summary',
      tags: ['admin:deposits'],
      summary: 'ยอดรวมการฝากเงินตามช่วงเวลา',
      description: 'ไทล์หน้าแดชบอร์ด (p.11) — นับจากตาราง deposits โดยตรง ไม่ใช่ค่าที่สรุปไว้ล่วงหน้า',
      security: bearerAuth,
      request: {
        query: z.object({
          prisonId: Ulid.optional(),
          from: z.coerce.number().int().optional(),
          to: z.coerce.number().int().optional()
        })
      },
      responses: { 200: jsonRes(DepositSummaryTotals, 'ยอดรวม'), ...commonErrors }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const { prisonId, from, to } = c.req.valid('query')
      const requested = resolvePrisonId(scope, prisonId ?? null)
      return c.json(depositTotals(requested, { from, to }), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/deposits/{id}',
      tags: ['admin:deposits'],
      summary: 'รายละเอียดการฝากเงิน',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(DepositDetail, 'รายการฝากเงิน'), ...commonErrors }
    }),
    async (c) => {
      const scope = prisonScope(c.get('staff'))
      const detail = await depositDetail(c.req.valid('param').id)
      assertInScope(scope, detail.prisonId)
      return c.json(detail, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/deposits/{id}/review',
      tags: ['admin:deposits'],
      summary: 'อัปเดตสถานะการฝากเงิน',
      description:
        '"เสร็จสิ้น" หมายถึงโอนเข้าบัญชีผู้ต้องขังในเรือนจำแล้ว จึงทำได้เฉพาะเมื่อสลิปผ่านการตรวจสอบ',
      security: bearerAuth,
      middleware: [canReview] as const,
      request: { params: z.object({ id: Ulid }), body: jsonBody(ReviewDepositInput) },
      responses: { 200: jsonRes(DepositDetail, 'อัปเดตแล้ว'), ...commonErrors }
    }),
    async (c) => {
      const actor = c.get('staff')!
      const scope = prisonScope(actor)
      const { id } = c.req.valid('param')
      const row = db().select().from(deposits).where(eq(deposits.id, id)).get()
      if (!row) throw notFound('ไม่พบรายการฝากเงิน')
      assertInScope(scope, row.prisonId)
      return c.json(
        await reviewDeposit(actor.id, id, c.req.valid('json'), requestContext(c)),
        200
      )
    }
  )

  /* ── deposit cards ─────────────────────────────────────────────────── */

  app.openapi(
    createRoute({
      method: 'get',
      path: '/deposit-cards',
      tags: ['admin:deposits'],
      summary: 'คำขอทำบัตรฝากเงิน',
      security: bearerAuth,
      request: {
        query: z.object({
          prisonId: Ulid.optional(),
          status: DepositCardStatus.default('pending'),
          limit: z.coerce.number().int().min(1).max(100).default(50)
        })
      },
      responses: {
        200: jsonRes(z.object({ items: z.array(DepositCard) }), 'บัตรฝากเงิน'),
        ...commonErrors
      }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const { prisonId, status, limit } = c.req.valid('query')
      const requested = resolvePrisonId(scope, prisonId ?? null)

      const items = depositCardQuery(db())
        .where(
          and(
            eq(depositCards.status, status),
            requested
              ? eq(depositCards.prisonId, requested)
              : scopeFilter(scope, depositCards.prisonId)
          )
        )
        .orderBy(desc(depositCards.createdAt))
        .limit(limit)
        .all()
      return c.json({ items }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/deposit-cards/{id}/review',
      tags: ['admin:deposits'],
      summary: 'อนุมัติ ปฏิเสธ หรือระงับบัตรฝากเงิน',
      description: 'เลขบัตรจะออกให้ครั้งแรกที่อนุมัติ และใช้เลขเดิมตลอดไป',
      security: bearerAuth,
      middleware: [canReview] as const,
      request: { params: z.object({ id: Ulid }), body: jsonBody(ReviewDepositCardInput) },
      responses: { 200: jsonRes(DepositCard, 'ผลการตรวจสอบ'), ...commonErrors }
    }),
    async (c) => {
      const actor = c.get('staff')!
      const scope = prisonScope(actor)
      const { id } = c.req.valid('param')
      const row = db().select().from(depositCards).where(eq(depositCards.id, id)).get()
      if (!row) throw notFound('ไม่พบบัตรฝากเงิน')
      assertInScope(scope, row.prisonId)
      return c.json(
        await reviewDepositCard(actor.id, id, c.req.valid('json'), requestContext(c)),
        200
      )
    }
  )

  return app
}
