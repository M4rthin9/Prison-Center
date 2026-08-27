import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import { RetentionReport, RunRetentionInput } from '@pc/contract'
import { db } from '../../db/client.js'
import { forbidden } from '../../lib/errors.js'
import { defaultHook } from '../../lib/hook.js'
import { bearerAuth, commonErrors, jsonBody, jsonRes } from '../../lib/openapi.js'
import { blockUntilPasswordChanged, requireRole, requireStaff } from '../../middleware/auth.js'
import type { AppEnv } from '../../types.js'
import { getSetting } from '../settings/service.js'
import { runRetention } from './service.js'

/**
 * Retention is department-wide by definition — the windows are one policy, not
 * one per facility — so only `super_admin` may look at it or run it.
 */
export function createAdminPdpaRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('/pdpa/*', requireStaff)
  app.use('/pdpa/*', blockUntilPasswordChanged)
  app.use('/pdpa/*', requireRole('super_admin'))

  app.openapi(
    createRoute({
      method: 'get',
      path: '/pdpa/retention/preview',
      tags: ['admin:pdpa'],
      summary: 'ดูว่างานลบข้อมูลตามระยะเวลาจะลบอะไรบ้าง (ไม่ลบจริง)',
      security: bearerAuth,
      responses: { 200: jsonRes(RetentionReport, 'รายงานแบบทดสอบ'), ...commonErrors }
    }),
    async (c) => c.json(await runRetention({ dryRun: true, db: db() }), 200)
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/pdpa/retention/run',
      tags: ['admin:pdpa'],
      summary: 'สั่งงานลบข้อมูลตามระยะเวลา',
      description:
        'ถ้ายังไม่เปิด pdpa.retention.enabled จะทำงานในโหมดทดสอบเท่านั้น — ' +
        'ค่าระยะเวลาต้องผ่านการเห็นชอบจากกรมก่อนจึงจะลบจริงได้',
      security: bearerAuth,
      request: { body: jsonBody(RunRetentionInput) },
      responses: { 200: jsonRes(RetentionReport, 'ผลการทำงาน'), ...commonErrors }
    }),
    async (c) => {
      const { dryRun } = c.req.valid('json')
      if (dryRun === false && !getSetting('pdpa.retention.enabled', { db: db() })) {
        throw forbidden('ยังไม่ได้เปิดใช้งานการลบข้อมูลจริง (pdpa.retention.enabled)')
      }
      return c.json(await runRetention({ dryRun, db: db() }), 200)
    }
  )

  return app
}
