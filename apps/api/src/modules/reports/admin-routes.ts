import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { ReportJob, ReportKind, ReportRequestInput, Ulid } from '@pc/contract'
import { db } from '../../db/client.js'
import { bearerAuth, commonErrors, jsonBody, jsonRes } from '../../lib/openapi.js'
import { defaultHook } from '../../lib/hook.js'
import { requestContext } from '../../lib/auth/session.js'
import { blockUntilPasswordChanged, requireRole, requireStaff } from '../../middleware/auth.js'
import { prisonScope, resolvePrisonId } from '../../middleware/prison-scope.js'
import type { AppEnv } from '../../types.js'
import { listReportJobs, readReportFile, requestReport, scopedReportJob } from './service.js'

/** Reports are the department's numbers. Front-desk roles do not export them. */
const canExport = requireRole('super_admin', 'prison_admin', 'finance')

export function createAdminReportRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireStaff)
  app.use('*', blockUntilPasswordChanged)

  app.openapi(
    createRoute({
      method: 'get',
      path: '/reports',
      tags: ['admin:reports'],
      summary: 'รายงานที่สั่งไว้ล่าสุด',
      security: bearerAuth,
      request: {
        query: z.object({
          kind: ReportKind.optional(),
          limit: z.coerce.number().int().min(1).max(100).default(25)
        })
      },
      responses: {
        200: jsonRes(z.object({ items: z.array(ReportJob) }), 'งานสร้างรายงาน'),
        ...commonErrors
      }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const { kind, limit } = c.req.valid('query')
      return c.json({ items: listReportJobs(scope, { kind, limit }, db()) }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/reports/{jobId}',
      tags: ['admin:reports'],
      summary: 'สถานะงานสร้างรายงาน',
      description: 'ฝั่งหน้าจอเรียกซ้ำจนกว่า status จะเป็น succeeded แล้วจึงดาวน์โหลด',
      security: bearerAuth,
      request: { params: z.object({ jobId: Ulid }) },
      responses: { 200: jsonRes(ReportJob, 'งานสร้างรายงาน'), ...commonErrors }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      return c.json(scopedReportJob(scope, c.req.valid('param').jobId, db()), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/reports/{kind}',
      tags: ['admin:reports'],
      summary: 'สั่งสร้างรายงาน XLSX',
      description:
        'คืนค่าทันทีพร้อม job id — ไฟล์ถูกสร้างในคิวงาน ไม่ผูกกับ request ' +
        'เจ้าหน้าที่ไม่ต้องรอหน้าจอค้างระหว่างที่ ExcelJS เขียนไฟล์',
      security: bearerAuth,
      middleware: [canExport] as const,
      request: {
        params: z.object({ kind: ReportKind }),
        body: jsonBody(ReportRequestInput)
      },
      responses: { 202: jsonRes(ReportJob, 'เข้าคิวแล้ว'), ...commonErrors }
    }),
    (c) => {
      const actor = c.get('staff')!
      const scope = prisonScope(actor)
      const { kind } = c.req.valid('param')
      const filters = c.req.valid('json')
      // super_admin may leave prisonId null for the department-wide roll-up.
      const prisonId = resolvePrisonId(scope, filters.prisonId ?? null)

      return c.json(
        requestReport(
          actor.id,
          kind,
          filters,
          prisonId,
          requestContext(c),
          db()
        ),
        202
      )
    }
  )

  // The XLSX itself: streamed through the API with a session, never from a
  // public path — these sheets carry names, phone numbers and amounts.
  app.get('/reports/:jobId/download', async (c) => {
    const scope = prisonScope(c.get('staff'))
    const file = await readReportFile(scope, c.req.param('jobId'), db())
    return c.body(new Uint8Array(file.body), 200, {
      'Content-Type': file.contentType,
      // Thai filenames need the RFC 5987 form; the ASCII fallback keeps old
      // clients from saving a file with a mangled name.
      'Content-Disposition': `attachment; filename="report.xlsx"; filename*=UTF-8''${encodeURIComponent(file.filename)}`,
      'Cache-Control': 'private, no-store'
    })
  })

  return app
}
