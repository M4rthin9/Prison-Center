import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { PublicSettings, Ulid } from '@pc/contract'
import { commonErrors, bearerAuth, jsonBody, jsonRes } from '../../lib/openapi.js'
import { defaultHook } from '../../lib/hook.js'
import { blockUntilPasswordChanged, requireStaff } from '../../middleware/auth.js'
import { prisonScope, resolvePrisonId } from '../../middleware/prison-scope.js'
import type { AppEnv } from '../../types.js'
import { listSettings, publicSettings, setSetting } from './service.js'
import { REGISTRY, isSettingKey } from './registry.js'
import { badRequest } from '../../lib/errors.js'

export function createPublicSettingsRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })

  app.openapi(
    createRoute({
      method: 'get',
      path: '/public',
      tags: ['settings'],
      summary: 'การตั้งค่าที่เปิดเผยต่อผู้ใช้ทั่วไป',
      request: { query: z.object({ prisonId: Ulid.optional() }) },
      responses: { 200: jsonRes(PublicSettings, 'การตั้งค่าสาธารณะ'), ...commonErrors }
    }),
    (c) => c.json(publicSettings({ prisonId: c.req.valid('query').prisonId ?? null }), 200)
  )

  return app
}

const SettingView = z.object({
  key: z.string(),
  label: z.string(),
  scope: z.enum(['global', 'prison']),
  exposed: z.boolean(),
  value: z.unknown(),
  isDefault: z.boolean()
})

export function createAdminSettingsRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireStaff)
  app.use('*', blockUntilPasswordChanged)

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['admin:settings'],
      summary: 'อ่านค่าทั้งหมดใน Settings Registry',
      security: bearerAuth,
      request: { query: z.object({ prisonId: Ulid.optional() }) },
      responses: {
        200: jsonRes(z.object({ items: z.array(SettingView) }), 'รายการการตั้งค่า'),
        ...commonErrors
      }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const prisonId = resolvePrisonId(scope, c.req.valid('query').prisonId ?? null)
      return c.json({ items: listSettings({ prisonId }) }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'put',
      path: '/{key}',
      tags: ['admin:settings'],
      summary: 'เขียนค่าหนึ่งคีย์',
      description: 'คีย์ที่ไม่ได้ประกาศไว้ใน registry จะถูกปฏิเสธ',
      security: bearerAuth,
      request: {
        params: z.object({ key: z.string() }),
        query: z.object({ prisonId: Ulid.optional() }),
        body: jsonBody(z.object({ value: z.unknown() }))
      },
      responses: { 200: jsonRes(SettingView, 'ค่าที่บันทึกแล้ว'), ...commonErrors }
    }),
    (c) => {
      const staff = c.get('staff')!
      const scope = prisonScope(staff)
      const { key } = c.req.valid('param')
      if (!isSettingKey(key)) throw badRequest(`ไม่รู้จักการตั้งค่า "${key}"`)

      const def = REGISTRY[key]
      const requested = c.req.valid('query').prisonId ?? null
      const prisonId = def.scope === 'prison' ? resolvePrisonId(scope, requested) : null
      if (def.scope === 'global' && scope.kind !== 'all') {
        throw badRequest('ค่านี้ตั้งได้เฉพาะผู้ดูแลระบบส่วนกลาง')
      }

      const value = setSetting(key, c.req.valid('json').value, {
        prisonId,
        actorId: staff.id
      })

      return c.json(
        {
          key,
          label: def.label,
          scope: def.scope,
          exposed: def.exposed,
          value,
          isDefault: JSON.stringify(value) === JSON.stringify(def.default)
        },
        200
      )
    }
  )

  return app
}
