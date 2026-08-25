import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, desc, eq, gte, like, lte, or, sql } from 'drizzle-orm'
import {
  CreateLetterBatchInput,
  CreateLetterPackageInput,
  LetterBatch,
  LetterDetail,
  LetterDirection,
  LetterPackage,
  LetterStatus,
  LetterSummary,
  LetterSummaryTotals,
  PageQuery,
  ScanReplyInput,
  ScanReplyResult,
  UpdateLetterPackageInput,
  UpdateLetterStatusInput,
  Ulid,
  pageOf
} from '@pc/contract'
import { db } from '../../db/client.js'
import { letterBatches, letterPackages, letters } from '../../db/schema/index.js'
import { badRequest, notFound } from '../../lib/errors.js'
import { decodeCursor, paginate } from '../../lib/cursor.js'
import { MAX_SCAN_BYTES } from '../../lib/letters/image.js'
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
  createBatch,
  createLetterPackage,
  letterBatchList,
  letterBatchView,
  letterDetail,
  letterPackageView,
  letterQuery,
  letterTotals,
  markBatchPrinted,
  packagesFor,
  readBatchFile,
  readScan,
  replyInfoFor,
  scanReply,
  updateLetterPackage,
  updateLetterStatus
} from './service.js'

/**
 * `letter_operator` is a real role in this system (§4.1b) and this is its
 * screen. Prison admins keep it too, because a small facility has one person.
 */
const canOperate = requireRole('super_admin', 'prison_admin', 'letter_operator')
const canConfigure = requireRole('super_admin', 'prison_admin')

const ScanBody = {
  content: {
    'multipart/form-data': {
      schema: z.object({
        file: z.any().openapi({ type: 'string', format: 'binary' }),
        letterNo: z.string().optional()
      })
    }
  },
  required: true as const
}

export function createAdminLetterRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireStaff)
  app.use('*', blockUntilPasswordChanged)

  /* ── the print queue ───────────────────────────────────────────────── */

  app.openapi(
    createRoute({
      method: 'get',
      path: '/letters',
      tags: ['admin:letters'],
      summary: 'คิวจดหมาย',
      description: 'เรียงเก่าก่อนเมื่อกรองสถานะ "รอพิมพ์" — คิวพิมพ์เดินตามลำดับที่ญาติส่งเข้ามา',
      security: bearerAuth,
      request: {
        query: PageQuery.extend({
          prisonId: Ulid.optional(),
          zoneId: Ulid.optional(),
          status: LetterStatus.optional(),
          direction: LetterDirection.optional(),
          batchId: Ulid.optional(),
          /** เลขที่จดหมาย ชื่อ/รหัสผู้ต้องขัง หรือชื่อญาติ */
          q: z.string().max(80).optional(),
          from: z.coerce.number().int().optional(),
          to: z.coerce.number().int().optional()
        })
      },
      responses: { 200: jsonRes(pageOf(LetterSummary), 'จดหมาย'), ...commonErrors }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const q = c.req.valid('query')
      const requested = resolvePrisonId(scope, q.prisonId ?? null)
      const after = decodeCursor(q.cursor)

      const rows = letterQuery(db())
        .where(
          and(
            requested ? eq(letters.prisonId, requested) : scopeFilter(scope, letters.prisonId),
            q.zoneId ? eq(letters.zoneId, q.zoneId) : undefined,
            q.status ? eq(letters.status, q.status) : undefined,
            q.direction ? eq(letters.direction, q.direction) : undefined,
            q.batchId ? eq(letters.batchId, q.batchId) : undefined,
            q.from ? gte(letters.createdAt, q.from) : undefined,
            q.to ? lte(letters.createdAt, q.to) : undefined,
            q.q
              ? or(
                  like(letters.letterNo, `%${q.q}%`),
                  like(letters.inmateNameSnapshot, `%${q.q}%`),
                  like(letters.inmateCodeSnapshot, `%${q.q}%`),
                  like(letters.customerNameSnapshot, `%${q.q}%`)
                )
              : undefined,
            after
              ? sql`(${letters.createdAt}, ${letters.id}) < (${after[0]}, ${after[1]})`
              : undefined
          )
        )
        .orderBy(desc(letters.createdAt), desc(letters.id))
        .limit(q.limit + 1)
        .all()

      const page = paginate(rows, q.limit, (r) => [r.createdAt, r.id])
      const { decorate } = replyInfoFor(page.items, db())
      return c.json({ items: page.items.map(decorate), nextCursor: page.nextCursor }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/letters/summary',
      tags: ['admin:letters'],
      summary: 'ยอดรวมจดหมายตามช่วงเวลา',
      description: 'ไทล์หน้าแดชบอร์ดและตั้งต้นรายงาน p.12 — นับจากตาราง letters โดยตรง',
      security: bearerAuth,
      request: {
        query: z.object({
          prisonId: Ulid.optional(),
          from: z.coerce.number().int().optional(),
          to: z.coerce.number().int().optional()
        })
      },
      responses: { 200: jsonRes(LetterSummaryTotals, 'ยอดรวม'), ...commonErrors }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const { prisonId, from, to } = c.req.valid('query')
      return c.json(letterTotals(resolvePrisonId(scope, prisonId ?? null), { from, to }), 200)
    }
  )

  /* ── batches ───────────────────────────────────────────────────────── */

  app.openapi(
    createRoute({
      method: 'get',
      path: '/letters/batches',
      tags: ['admin:letters'],
      summary: 'รอบพิมพ์จดหมาย',
      security: bearerAuth,
      request: {
        query: z.object({
          prisonId: Ulid.optional(),
          limit: z.coerce.number().int().min(1).max(100).default(30)
        })
      },
      responses: {
        200: jsonRes(z.object({ items: z.array(LetterBatch) }), 'รอบพิมพ์'),
        ...commonErrors
      }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const { prisonId, limit } = c.req.valid('query')
      const requested = resolvePrisonId(scope, prisonId ?? null)
      const where = and(
        requested
          ? eq(letterBatches.prisonId, requested)
          : scopeFilter(scope, letterBatches.prisonId)
      )
      return c.json({ items: letterBatchList(where, limit, db()) }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/letters/batches',
      tags: ['admin:letters'],
      summary: 'สร้างรอบพิมพ์ (จัดคิวงานสร้าง PDF)',
      description:
        'จองจดหมายที่รอพิมพ์เข้ารอบทันทีในทรานแซกชันเดียว แล้วส่งงานวาดไฟล์เข้าคิว — จดหมายฉบับเดียวกันจึงเข้าสองรอบไม่ได้',
      security: bearerAuth,
      middleware: [canOperate] as const,
      request: { body: jsonBody(CreateLetterBatchInput) },
      responses: { 201: jsonRes(LetterBatch, 'รอบพิมพ์'), ...commonErrors }
    }),
    (c) => {
      const actor = c.get('staff')!
      const scope = prisonScope(actor)
      const input = c.req.valid('json')
      const prisonId = resolvePrisonId(scope, input.prisonId ?? null)
      if (!prisonId) throw badRequest('ต้องระบุเรือนจำ', { prisonId: ['ต้องระบุเรือนจำ'] })
      return c.json(createBatch(actor.id, prisonId, input, requestContext(c)), 201)
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/letters/batches/{id}',
      tags: ['admin:letters'],
      summary: 'รายละเอียดรอบพิมพ์',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(LetterBatch, 'รอบพิมพ์'), ...commonErrors }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const batch = letterBatchView(c.req.valid('param').id)
      assertInScope(scope, batch.prisonId)
      return c.json(batch, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/letters/batches/{id}/printed',
      tags: ['admin:letters'],
      summary: 'ยืนยันว่าพิมพ์รอบนี้แล้ว',
      description: 'เปลี่ยนสถานะจดหมายทุกฉบับในรอบเป็น "พิมพ์แล้ว" และแจ้งญาติ',
      security: bearerAuth,
      middleware: [canOperate] as const,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(LetterBatch, 'พิมพ์แล้ว'), ...commonErrors }
    }),
    async (c) => {
      const actor = c.get('staff')!
      const scope = prisonScope(actor)
      const { id } = c.req.valid('param')
      assertInScope(scope, letterBatchView(id).prisonId)
      return c.json(await markBatchPrinted(actor.id, id), 200)
    }
  )

  // The batch file is a stack of family correspondence: served through the API
  // with a session, never from a public path.
  app.get('/letters/batches/:id/file', async (c) => {
    const scope = prisonScope(c.get('staff'))
    const id = c.req.param('id')
    assertInScope(scope, letterBatchView(id).prisonId)
    const file = await readBatchFile(id)
    return c.body(new Uint8Array(file.body), 200, {
      'Content-Type': file.contentType,
      'Content-Disposition': `inline; filename="${file.filename}"`,
      'Cache-Control': 'private, max-age=60'
    })
  })

  /* ── one letter ────────────────────────────────────────────────────── */

  app.openapi(
    createRoute({
      method: 'get',
      path: '/letters/{id}',
      tags: ['admin:letters'],
      summary: 'รายละเอียดจดหมาย',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(LetterDetail, 'จดหมาย'), ...commonErrors }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const detail = letterDetail(c.req.valid('param').id)
      assertInScope(scope, detail.prisonId)
      return c.json(detail, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/letters/{id}/status',
      tags: ['admin:letters'],
      summary: 'อัปเดตสถานะจดหมาย',
      description: 'ไม่อนุญาต = คืนสิทธิ์ให้ญาติ 1 ฉบับ ถ้ายังไม่ได้ส่งถึงมือ',
      security: bearerAuth,
      middleware: [canOperate] as const,
      request: { params: z.object({ id: Ulid }), body: jsonBody(UpdateLetterStatusInput) },
      responses: { 200: jsonRes(LetterDetail, 'อัปเดตแล้ว'), ...commonErrors }
    }),
    async (c) => {
      const actor = c.get('staff')!
      const scope = prisonScope(actor)
      const { id } = c.req.valid('param')
      const row = db().select().from(letters).where(eq(letters.id, id)).get()
      if (!row) throw notFound('ไม่พบจดหมาย')
      assertInScope(scope, row.prisonId)
      return c.json(
        await updateLetterStatus(actor.id, id, c.req.valid('json'), requestContext(c)),
        200
      )
    }
  )

  app.get('/letters/:id/scan', async (c) => {
    const scope = prisonScope(c.get('staff'))
    const id = c.req.param('id')
    const row = db().select().from(letters).where(eq(letters.id, id)).get()
    if (!row) throw notFound('ไม่พบจดหมาย')
    assertInScope(scope, row.prisonId)
    const buf = await readScan(id)
    return c.body(new Uint8Array(buf), 200, {
      'Content-Type': 'image/jpeg',
      'Cache-Control': 'private, max-age=300'
    })
  })

  /* ── scan-reply intake (p.6) ───────────────────────────────────────── */

  app.openapi(
    createRoute({
      method: 'post',
      path: '/letters/scan-reply',
      tags: ['admin:letters'],
      summary: 'นำเข้าจดหมายตอบกลับที่สแกนแล้ว',
      description:
        'อ่าน QR บนแบบฟอร์มตอบกลับเพื่อหาเลขที่จดหมายต้นทาง แล้วสร้างจดหมายขาส่งกลับบ้านผูกกับฉบับนั้น — ถ้า QR อ่านไม่ได้ ให้กรอก letterNo เอง',
      security: bearerAuth,
      middleware: [canOperate] as const,
      request: { body: ScanBody },
      responses: { 201: jsonRes(ScanReplyResult, 'ผลการนำเข้า'), ...commonErrors }
    }),
    async (c) => {
      const actor = c.get('staff')!
      const scope = prisonScope(actor)
      const body = await c.req.parseBody()
      const file = body['file']
      if (!(file instanceof File)) throw badRequest('ต้องแนบไฟล์สแกนในฟิลด์ "file"')
      if (file.size > MAX_SCAN_BYTES) throw badRequest('ไฟล์สแกนใหญ่เกิน 16 MB')

      const letterNo = typeof body['letterNo'] === 'string' ? body['letterNo'] : undefined
      const parsed = ScanReplyInput.parse({ letterNo })

      const result = await scanReply(
        actor.id,
        {
          buffer: Buffer.from(await file.arrayBuffer()),
          contentType: file.type || undefined,
          filename: file.name
        },
        parsed,
        requestContext(c)
      )
      if (result.letter) assertInScope(scope, result.letter.prisonId)
      return c.json(result, 201)
    }
  )

  /* ── packages (ตั้งค่า) ─────────────────────────────────────────────── */

  app.openapi(
    createRoute({
      method: 'get',
      path: '/letter-packages',
      tags: ['admin:letters'],
      summary: 'แพ็กเกจจดหมายทั้งหมด',
      security: bearerAuth,
      request: {
        query: z.object({
          prisonId: Ulid.optional(),
          includeInactive: z.coerce.boolean().optional()
        })
      },
      responses: {
        200: jsonRes(z.object({ items: z.array(LetterPackage) }), 'แพ็กเกจ'),
        ...commonErrors
      }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const { prisonId, includeInactive } = c.req.valid('query')
      const requested = resolvePrisonId(scope, prisonId ?? null)
      return c.json(
        { items: packagesFor(requested, { includeInactive: includeInactive ?? true }, db()) },
        200
      )
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/letter-packages',
      tags: ['admin:letters'],
      summary: 'เพิ่มแพ็กเกจจดหมาย',
      security: bearerAuth,
      middleware: [canConfigure] as const,
      request: { body: jsonBody(CreateLetterPackageInput) },
      responses: { 201: jsonRes(LetterPackage, 'แพ็กเกจ'), ...commonErrors }
    }),
    (c) => {
      const actor = c.get('staff')!
      const scope = prisonScope(actor)
      const input = c.req.valid('json')
      // A prison_admin may only create packages for their own facility; only
      // super_admin may leave prisonId null (department-wide).
      const prisonId =
        scope.kind === 'all'
          ? (input.prisonId ?? null)
          : resolvePrisonId(scope, input.prisonId ?? null)
      return c.json(createLetterPackage(actor.id, { ...input, prisonId }, db()), 201)
    }
  )

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/letter-packages/{id}',
      tags: ['admin:letters'],
      summary: 'แก้ไขแพ็กเกจจดหมาย',
      security: bearerAuth,
      middleware: [canConfigure] as const,
      request: { params: z.object({ id: Ulid }), body: jsonBody(UpdateLetterPackageInput) },
      responses: { 200: jsonRes(LetterPackage, 'แพ็กเกจ'), ...commonErrors }
    }),
    (c) => {
      const actor = c.get('staff')!
      const scope = prisonScope(actor)
      const { id } = c.req.valid('param')
      const row = db().select().from(letterPackages).where(eq(letterPackages.id, id)).get()
      if (!row) throw notFound('ไม่พบแพ็กเกจจดหมาย')
      // Department-wide packages belong to super_admin alone.
      if (row.prisonId === null) prisonScopeAllOnly(scope)
      else assertInScope(scope, row.prisonId)
      letterPackageView(id, db())
      return c.json(updateLetterPackage(actor.id, id, c.req.valid('json'), db()), 200)
    }
  )

  return app
}

function prisonScopeAllOnly(scope: ReturnType<typeof prisonScope>) {
  if (scope.kind !== 'all') {
    throw notFound('ไม่พบแพ็กเกจจดหมาย')
  }
}
