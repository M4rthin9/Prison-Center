import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq, isNull, like, or, sql } from 'drizzle-orm'
import {
  CreateNewsInput,
  NewsDetail,
  NewsStatus,
  NewsSummary,
  PageQuery,
  UpdateNewsInput,
  Ulid,
  pageOf
} from '@pc/contract'
import { db } from '../../db/client.js'
import { news } from '../../db/schema/index.js'
import { badRequest, forbidden, notFound } from '../../lib/errors.js'
import { decodeCursor, paginate } from '../../lib/cursor.js'
import { bearerAuth, commonErrors, jsonBody, jsonRes } from '../../lib/openapi.js'
import { defaultHook } from '../../lib/hook.js'
import { requestContext } from '../../lib/auth/session.js'
import { blockUntilPasswordChanged, requireRole, requireStaff } from '../../middleware/auth.js'
import { assertInScope, prisonScope, type PrisonScope } from '../../middleware/prison-scope.js'
import type { AppEnv } from '../../types.js'
import {
  MAX_COVER_BYTES,
  createNews,
  deleteNews,
  newsDetail,
  newsQuery,
  removeCover,
  setCover,
  toSummary,
  updateNews
} from './service.js'

/** Publishing to families is an announcement, not data entry. Admins only. */
const canPublish = requireRole('super_admin', 'prison_admin')

const CoverBody = {
  content: {
    'multipart/form-data': {
      schema: z.object({ file: z.any().openapi({ type: 'string', format: 'binary' }) })
    }
  },
  required: true as const
}

/**
 * A department-wide notice (`prison_id` NULL) is visible from every prison, so
 * only a super_admin may write one. A prison_admin editing it would be editing
 * every other facility's front page.
 */
function assertCanEdit(scope: PrisonScope, rowPrisonId: string | null) {
  if (rowPrisonId === null) {
    if (scope.kind !== 'all') throw forbidden('ประกาศส่วนกลางแก้ไขได้เฉพาะผู้ดูแลระบบส่วนกลาง')
    return
  }
  assertInScope(scope, rowPrisonId)
}

export function createAdminNewsRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireStaff)
  app.use('*', blockUntilPasswordChanged)

  app.openapi(
    createRoute({
      method: 'get',
      path: '/news',
      tags: ['admin:news'],
      summary: 'ข่าวทั้งหมดในขอบเขตของผู้ใช้',
      description: 'รวมประกาศส่วนกลางเสมอ — เจ้าหน้าที่ต้องเห็นสิ่งที่ญาติเห็น',
      security: bearerAuth,
      request: {
        query: PageQuery.extend({
          prisonId: Ulid.optional(),
          status: NewsStatus.optional(),
          q: z.string().max(80).optional()
        })
      },
      responses: { 200: jsonRes(pageOf(NewsSummary), 'รายการข่าว'), ...commonErrors }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const { cursor, limit, prisonId, status, q } = c.req.valid('query')
      const after = decodeCursor(cursor)

      const requested = prisonId ?? (scope.kind === 'prison' ? scope.prisonId : null)
      const rows = newsQuery(db())
        .where(
          and(
            requested ? or(isNull(news.prisonId), eq(news.prisonId, requested)) : undefined,
            status ? eq(news.status, status) : undefined,
            q ? like(news.title, `%${q}%`) : undefined,
            after ? sql`(${news.createdAt}, ${news.id}) < (${after[0]}, ${after[1]})` : undefined
          )
        )
        .orderBy(desc(news.createdAt), desc(news.id))
        .limit(limit + 1)
        .all()

      const page = paginate(rows, limit, (r) => [r.createdAt, r.id])
      return c.json({ items: page.items.map(toSummary), nextCursor: page.nextCursor }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/news/{id}',
      tags: ['admin:news'],
      summary: 'ข่าวหนึ่งเรื่อง (รวมฉบับร่าง)',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(NewsDetail, 'ข่าว'), ...commonErrors }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const detail = newsDetail(c.req.valid('param').id)
      // Reading a sibling prison's draft is still a scope leak.
      if (detail.prisonId !== null) assertInScope(scope, detail.prisonId)
      return c.json(detail, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/news',
      tags: ['admin:news'],
      summary: 'สร้างข่าว',
      description:
        'ไม่ระบุ prisonId = เรือนจำของผู้เขียน · ระบุเป็น null = ประกาศส่วนกลาง (เฉพาะผู้ดูแลส่วนกลาง)',
      security: bearerAuth,
      middleware: [canPublish] as const,
      request: { body: jsonBody(CreateNewsInput) },
      responses: { 201: jsonRes(NewsDetail, 'สร้างแล้ว'), ...commonErrors }
    }),
    (c) => {
      const actor = c.get('staff')!
      const scope = prisonScope(actor)
      const input = c.req.valid('json')

      // `undefined` means "mine"; an explicit `null` means department-wide.
      const prisonId =
        input.prisonId === undefined
          ? scope.kind === 'prison'
            ? scope.prisonId
            : null
          : input.prisonId
      assertCanEdit(scope, prisonId)

      return c.json(createNews(actor.id, { ...input, prisonId }, requestContext(c)), 201)
    }
  )

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/news/{id}',
      tags: ['admin:news'],
      summary: 'แก้ไขข่าว',
      description: 'slug ของข่าวที่เผยแพร่แล้วจะไม่เปลี่ยนตามหัวข้อ เพราะลิงก์ถูกส่งต่อไปแล้ว',
      security: bearerAuth,
      middleware: [canPublish] as const,
      request: { params: z.object({ id: Ulid }), body: jsonBody(UpdateNewsInput) },
      responses: { 200: jsonRes(NewsDetail, 'แก้ไขแล้ว'), ...commonErrors }
    }),
    (c) => {
      const actor = c.get('staff')!
      const { id } = c.req.valid('param')
      assertCanEdit(prisonScope(actor), rowPrisonId(id))
      return c.json(updateNews(actor.id, id, c.req.valid('json'), requestContext(c)), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/news/{id}',
      tags: ['admin:news'],
      summary: 'ลบข่าว',
      security: bearerAuth,
      middleware: [canPublish] as const,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(z.object({ ok: z.literal(true) }), 'ลบแล้ว'), ...commonErrors }
    }),
    async (c) => {
      const actor = c.get('staff')!
      const { id } = c.req.valid('param')
      assertCanEdit(prisonScope(actor), rowPrisonId(id))
      await deleteNews(actor.id, id, requestContext(c))
      return c.json({ ok: true as const }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/news/{id}/cover',
      tags: ['admin:news'],
      summary: 'อัปโหลดภาพปก',
      description: 'ระบบลบข้อมูล EXIF และย่อภาพก่อนจัดเก็บ เช่นเดียวกับรูปแนบจดหมาย',
      security: bearerAuth,
      middleware: [canPublish] as const,
      request: { params: z.object({ id: Ulid }), body: CoverBody },
      responses: { 200: jsonRes(NewsDetail, 'อัปโหลดแล้ว'), ...commonErrors }
    }),
    async (c) => {
      const actor = c.get('staff')!
      const { id } = c.req.valid('param')
      assertCanEdit(prisonScope(actor), rowPrisonId(id))

      const body = await c.req.parseBody()
      const file = body['file']
      if (!(file instanceof File)) throw badRequest('ต้องแนบไฟล์ภาพในฟิลด์ "file"')
      if (file.size > MAX_COVER_BYTES) throw badRequest('ภาพปกใหญ่เกิน 6 MB')

      return c.json(
        await setCover(actor.id, id, {
          buffer: Buffer.from(await file.arrayBuffer()),
          contentType: file.type || undefined
        }),
        200
      )
    }
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/news/{id}/cover',
      tags: ['admin:news'],
      summary: 'ลบภาพปก',
      security: bearerAuth,
      middleware: [canPublish] as const,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(NewsDetail, 'ลบแล้ว'), ...commonErrors }
    }),
    async (c) => {
      const actor = c.get('staff')!
      const { id } = c.req.valid('param')
      assertCanEdit(prisonScope(actor), rowPrisonId(id))
      return c.json(await removeCover(actor.id, id), 200)
    }
  )

  return app
}

function rowPrisonId(id: string): string | null {
  const row = db().select({ prisonId: news.prisonId }).from(news).where(eq(news.id, id)).get()
  if (!row) throw notFound('ไม่พบข่าวนี้')
  return row.prisonId
}
