import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import { DashboardQuery, DashboardSummary } from '@pc/contract'
import { db } from '../../db/client.js'
import { bearerAuth, commonErrors, jsonRes } from '../../lib/openapi.js'
import { defaultHook } from '../../lib/hook.js'
import { blockUntilPasswordChanged, requireStaff } from '../../middleware/auth.js'
import { prisonScope, resolvePrisonId } from '../../middleware/prison-scope.js'
import type { AppEnv } from '../../types.js'
import { dashboardSummary } from './service.js'

/** p.11 — one request, four tiles, the period chart, and the work queues. */
export function createAdminDashboardRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireStaff)
  app.use('*', blockUntilPasswordChanged)

  app.openapi(
    createRoute({
      method: 'get',
      path: '/dashboard/summary',
      tags: ['admin:dashboard'],
      summary: 'ภาพรวม 4 ไทล์ ตามช่วงเวลา',
      description:
        'ทุกตัวเลขนับจากตารางธุรกิจโดยตรงตอนเรียก ไม่มีค่าสรุปที่เก็บไว้ล่วงหน้า ' +
        'ช่วงเวลาคิดตามเวลาไทย (UTC+7) เสมอ',
      security: bearerAuth,
      request: { query: DashboardQuery },
      responses: { 200: jsonRes(DashboardSummary, 'ภาพรวม'), ...commonErrors }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const { prisonId, period, from, to } = c.req.valid('query')
      // super_admin with no prison filter sees the department-wide roll-up.
      const requested = resolvePrisonId(scope, prisonId ?? null)
      return c.json(dashboardSummary(requested, { period, from, to }, db()), 200)
    }
  )

  return app
}
