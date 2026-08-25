import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, eq, isNull, like, or, sql } from 'drizzle-orm'
import {
  CreateInmateInput,
  ImportOptions,
  ImportPreview,
  ImportRowResult,
  ImportRowView,
  ImportRunSummary,
  InmateRow,
  InmateStatus,
  PageQuery,
  TransferInmateInput,
  Ulid,
  UpdateInmateInput,
  pageOf
} from '@pc/contract'
import { db } from '../../db/client.js'
import { inmateImportRuns, inmates } from '../../db/schema/index.js'
import { badRequest } from '../../lib/errors.js'
import { decodeCursor, paginate } from '../../lib/cursor.js'
import { bearerAuth, commonErrors, jsonBody, jsonRes } from '../../lib/openapi.js'
import { defaultHook } from '../../lib/hook.js'
import { requestContext } from '../../lib/auth/session.js'
import { MAX_IMPORT_BYTES } from '../../lib/import/table.js'
import { blockUntilPasswordChanged, requireRole, requireStaff } from '../../middleware/auth.js'
import {
  assertInScope,
  prisonScope,
  resolvePrisonId,
  scopeFilter
} from '../../middleware/prison-scope.js'
import type { AppEnv } from '../../types.js'
import {
  createInmate,
  deleteInmate,
  inmateQuery,
  inmateRecord,
  inmateView,
  restoreInmate,
  transferInmate,
  updateInmate
} from './service.js'
import {
  applyImport,
  dryRunImport,
  importRunRows,
  importRuns,
  readErrorReport,
  runSummary
} from './import.js'

/** Master data about people. Only these two roles may write it. */
const canEditInmates = requireRole('super_admin', 'prison_admin')
const Flag = z.enum(['true', 'false']).optional()

const ImportForm = {
  content: {
    'multipart/form-data': {
      schema: z.object({
        file: z.any().openapi({ type: 'string', format: 'binary' }),
        prisonId: z.string().optional(),
        source: z.string().optional(),
        createZones: z.string().optional(),
        missingPolicy: z.string().optional()
      })
    }
  },
  required: true as const
}

export function createAdminInmateRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireStaff)
  app.use('*', blockUntilPasswordChanged)

  /* ── import (must precede /inmates/{id}) ───────────────────────────── */

  app.openapi(
    createRoute({
      method: 'post',
      path: '/inmates/import',
      tags: ['admin:inmates'],
      summary: 'ตรวจสอบไฟล์รายชื่อผู้ต้องขัง (dry-run)',
      description:
        'อ่านไฟล์ .xlsx หรือ .csv (รองรับ TIS-620) แล้วคืนผลต่างทีละแถวโดยยังไม่เขียนฐานข้อมูล — ' +
        'ไฟล์ถูกเก็บไว้เพื่อให้ขั้นยืนยันใช้ไฟล์เดิมทุกไบต์',
      security: bearerAuth,
      middleware: [canEditInmates] as const,
      request: { body: ImportForm },
      responses: { 200: jsonRes(ImportPreview, 'ผลต่างที่จะเกิดขึ้น'), ...commonErrors }
    }),
    async (c) => {
      const actor = c.get('staff')!
      const scope = prisonScope(actor)
      const body = await c.req.parseBody()

      const file = body['file']
      if (!(file instanceof File)) throw badRequest('ต้องแนบไฟล์ในฟิลด์ "file"')
      if (file.size > MAX_IMPORT_BYTES) throw badRequest('ไฟล์ใหญ่เกิน 10 MB')

      const options = ImportOptions.parse({
        source: typeof body['source'] === 'string' && body['source'] ? body['source'] : undefined,
        createZones: body['createZones'] === 'true',
        missingPolicy:
          typeof body['missingPolicy'] === 'string' && body['missingPolicy']
            ? body['missingPolicy']
            : undefined
      })
      const prisonId = resolvePrisonId(
        scope,
        typeof body['prisonId'] === 'string' ? body['prisonId'] : null
      )
      if (!prisonId) throw badRequest('ต้องระบุเรือนจำที่จะนำเข้า', { prisonId: ['ต้องระบุ'] })

      const preview = await dryRunImport(
        actor.id,
        prisonId,
        { buffer: Buffer.from(await file.arrayBuffer()), filename: file.name },
        options
      )
      return c.json(preview, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/inmates/import/{runId}/apply',
      tags: ['admin:inmates'],
      summary: 'ยืนยันการนำเข้าตามผลตรวจสอบ',
      description:
        'อ่านไฟล์เดิมซ้ำและคำนวณผลต่างใหม่กับฐานข้อมูลปัจจุบัน ตัวเลขที่คืนกลับคือสิ่งที่เกิดขึ้นจริง',
      security: bearerAuth,
      middleware: [canEditInmates] as const,
      request: { params: z.object({ runId: Ulid }) },
      responses: { 200: jsonRes(ImportPreview, 'ผลการนำเข้า'), ...commonErrors }
    }),
    async (c) => {
      const actor = c.get('staff')!
      const scope = prisonScope(actor)
      const { runId } = c.req.valid('param')
      assertInScope(scope, runSummary(runId).prisonId)
      return c.json(await applyImport(actor.id, runId), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/inmates/import-runs',
      tags: ['admin:inmates'],
      summary: 'ประวัติการนำเข้ารายชื่อ',
      security: bearerAuth,
      request: {
        query: z.object({
          prisonId: Ulid.optional(),
          limit: z.coerce.number().int().min(1).max(100).default(20)
        })
      },
      responses: {
        200: jsonRes(z.object({ items: z.array(ImportRunSummary) }), 'รอบการนำเข้า'),
        ...commonErrors
      }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const { prisonId, limit } = c.req.valid('query')
      const requested = resolvePrisonId(scope, prisonId ?? null)
      const filter = requested
        ? eq(inmateImportRuns.prisonId, requested)
        : scopeFilter(scope, inmateImportRuns.prisonId)
      return c.json({ items: importRuns(filter, limit) }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/inmates/import-runs/{runId}',
      tags: ['admin:inmates'],
      summary: 'ผลต่างรายแถวของรอบการนำเข้า',
      security: bearerAuth,
      request: {
        params: z.object({ runId: Ulid }),
        query: z.object({
          result: ImportRowResult.optional(),
          limit: z.coerce.number().int().min(1).max(500).default(200)
        })
      },
      responses: {
        200: jsonRes(
          z.object({ run: ImportRunSummary, rows: z.array(ImportRowView) }),
          'ผลต่างรายแถว'
        ),
        ...commonErrors
      }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const { runId } = c.req.valid('param')
      const { result, limit } = c.req.valid('query')
      const run = runSummary(runId)
      assertInScope(scope, run.prisonId)
      return c.json({ run, rows: importRunRows(runId, result, limit) }, 200)
    }
  )

  // The error report is a real XLSX the clerk fixes and re-uploads, so it is
  // streamed through the API rather than exposed as a public storage URL.
  app.get('/inmates/import-runs/:runId/errors.xlsx', async (c) => {
    const scope = prisonScope(c.get('staff'))
    const { run, buffer } = await readErrorReport(c.req.param('runId'))
    assertInScope(scope, run.prisonId)
    return c.body(new Uint8Array(buffer), 200, {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="import-errors-${run.id}.xlsx"`,
      'Cache-Control': 'private, max-age=60'
    })
  })

  /* ── CRUD ──────────────────────────────────────────────────────────── */

  app.openapi(
    createRoute({
      method: 'get',
      path: '/inmates',
      tags: ['admin:inmates'],
      summary: 'ค้นหาผู้ต้องขัง',
      security: bearerAuth,
      request: {
        query: PageQuery.extend({
          prisonId: Ulid.optional(),
          zoneId: Ulid.optional(),
          status: InmateStatus.optional(),
          q: z.string().trim().max(60).optional(),
          includeDeleted: Flag
        })
      },
      responses: { 200: jsonRes(pageOf(InmateRow), 'รายชื่อผู้ต้องขัง'), ...commonErrors }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const { cursor, limit, prisonId, zoneId, status, q, includeDeleted } = c.req.valid('query')
      const requested = resolvePrisonId(scope, prisonId ?? null)
      const after = decodeCursor(cursor)

      const rows = inmateQuery(db())
        .where(
          and(
            requested ? eq(inmates.prisonId, requested) : scopeFilter(scope, inmates.prisonId),
            zoneId ? eq(inmates.zoneId, zoneId) : undefined,
            status ? eq(inmates.status, status) : undefined,
            includeDeleted === 'true' ? undefined : isNull(inmates.deletedAt),
            q
              ? or(like(inmates.fullName, `%${q}%`), like(inmates.inmateCode, `%${q}%`))
              : undefined,
            // Alphabetical by registration number — the order a clerk reads.
            after
              ? sql`(${inmates.inmateCode}, ${inmates.id}) > (${after[0]}, ${after[1]})`
              : undefined
          )
        )
        .orderBy(inmates.inmateCode, inmates.id)
        .limit(limit + 1)
        .all()

      const page = paginate(rows, limit, (r) => [r.inmateCode, r.id])
      return c.json(page, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/inmates',
      tags: ['admin:inmates'],
      summary: 'เพิ่มผู้ต้องขังด้วยมือ',
      description: 'รายการที่เพิ่มเองจะถูกตั้ง is_locally_edited ทันที ไฟล์นำเข้ารอบถัดไปจะไม่ทับชื่อ',
      security: bearerAuth,
      middleware: [canEditInmates] as const,
      request: { body: jsonBody(CreateInmateInput) },
      responses: { 201: jsonRes(InmateRow, 'ผู้ต้องขังที่เพิ่มแล้ว'), ...commonErrors }
    }),
    (c) => {
      const actor = c.get('staff')!
      const scope = prisonScope(actor)
      const input = c.req.valid('json')
      const prisonId = resolvePrisonId(scope, input.prisonId ?? null)
      if (!prisonId) throw badRequest('ต้องระบุเรือนจำ', { prisonId: ['ต้องระบุเรือนจำ'] })
      const ctx = requestContext(c)
      return c.json(createInmate(actor.id, prisonId, input, ctx), 201)
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/inmates/{id}',
      tags: ['admin:inmates'],
      summary: 'ข้อมูลผู้ต้องขัง',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(InmateRow, 'ผู้ต้องขัง'), ...commonErrors }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const { id } = c.req.valid('param')
      const row = inmateRecord(id)
      assertInScope(scope, row.prisonId)
      return c.json(inmateView(id), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/inmates/{id}',
      tags: ['admin:inmates'],
      summary: 'แก้ไขข้อมูลผู้ต้องขัง',
      security: bearerAuth,
      middleware: [canEditInmates] as const,
      request: { params: z.object({ id: Ulid }), body: jsonBody(UpdateInmateInput) },
      responses: { 200: jsonRes(InmateRow, 'อัปเดตแล้ว'), ...commonErrors }
    }),
    (c) => {
      const actor = c.get('staff')!
      const scope = prisonScope(actor)
      const { id } = c.req.valid('param')
      assertInScope(scope, inmateRecord(id).prisonId)
      return c.json(updateInmate(actor.id, id, c.req.valid('json'), requestContext(c)), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/inmates/{id}/transfer',
      tags: ['admin:inmates'],
      summary: 'ย้ายผู้ต้องขังไปเรือนจำหรือแดนอื่น',
      description: 'คำสั่งซื้อ จดหมาย และการฝากเงินเดิมยังคงผูกกับแดนที่บันทึกไว้ตอนสร้าง',
      security: bearerAuth,
      middleware: [canEditInmates] as const,
      request: { params: z.object({ id: Ulid }), body: jsonBody(TransferInmateInput) },
      responses: { 200: jsonRes(InmateRow, 'ย้ายแล้ว'), ...commonErrors }
    }),
    (c) => {
      const actor = c.get('staff')!
      const scope = prisonScope(actor)
      const { id } = c.req.valid('param')
      const input = c.req.valid('json')
      assertInScope(scope, inmateRecord(id).prisonId)
      // A prison_admin may move someone out, never into a facility they do not
      // administer — that import belongs to the receiving prison's staff.
      assertInScope(scope, input.toPrisonId)
      return c.json(transferInmate(actor.id, id, input, requestContext(c)), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'delete',
      path: '/inmates/{id}',
      tags: ['admin:inmates'],
      summary: 'ลบผู้ต้องขัง (soft delete)',
      description: 'ปฏิเสธเมื่อยังมีคำสั่งซื้อค้างชำระ และไม่เคยลบแถวจริงเพื่อไม่ให้บัญชีขาด',
      security: bearerAuth,
      middleware: [canEditInmates] as const,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(InmateRow, 'ลบแล้ว'), ...commonErrors }
    }),
    (c) => {
      const actor = c.get('staff')!
      const scope = prisonScope(actor)
      const { id } = c.req.valid('param')
      assertInScope(scope, inmateRecord(id).prisonId)
      return c.json(deleteInmate(actor.id, id, requestContext(c)), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/inmates/{id}/restore',
      tags: ['admin:inmates'],
      summary: 'กู้คืนผู้ต้องขังที่ถูกลบ',
      security: bearerAuth,
      middleware: [canEditInmates] as const,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(InmateRow, 'กู้คืนแล้ว'), ...commonErrors }
    }),
    (c) => {
      const actor = c.get('staff')!
      const scope = prisonScope(actor)
      const { id } = c.req.valid('param')
      assertInScope(scope, inmateRecord(id).prisonId)
      return c.json(restoreInmate(actor.id, id), 200)
    }
  )

  return app
}
