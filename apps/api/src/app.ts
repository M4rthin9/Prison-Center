import { OpenAPIHono } from '@hono/zod-openapi'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { secureHeaders } from 'hono/secure-headers'
import { serveStatic } from '@hono/node-server/serve-static'
import path from 'node:path'
import { env } from './env.js'
import { onError, onNotFound } from './middleware/error.js'
import { requestId } from './middleware/request-id.js'
import { defaultHook } from './lib/hook.js'
import { customerRealm, staffRealm } from './lib/auth/realms.js'
import { createAuthRoutes } from './modules/auth/routes.js'
import { customerPasswordProvider, staffPasswordProvider } from './modules/auth/service.js'
import { createMeRoutes } from './modules/me/routes.js'
import { createPrisonRoutes } from './modules/prisons/routes.js'
import { createCatalogRoutes } from './modules/catalog/routes.js'
import { createAdminCatalogRoutes } from './modules/catalog/admin-routes.js'
import { createOrderRoutes } from './modules/orders/routes.js'
import { createAdminOrderRoutes } from './modules/orders/admin-routes.js'
import { createAdminInmateRoutes } from './modules/inmates/admin-routes.js'
import { createPaymentChannelRoutes, createPaymentRoutes } from './modules/payments/routes.js'
import { createAdminPaymentRoutes } from './modules/payments/admin-routes.js'
import { createDepositCardRoutes, createDepositRoutes } from './modules/deposits/routes.js'
import { createAdminDepositRoutes } from './modules/deposits/admin-routes.js'
import {
  createLetterPackageRoutes,
  createLetterPurchaseRoutes,
  createLetterRoutes
} from './modules/letters/routes.js'
import { createAdminLetterRoutes } from './modules/letters/admin-routes.js'
import { createVisitRoutes } from './modules/visits/routes.js'
import { createAdminVisitRoutes } from './modules/visits/admin-routes.js'
import { createAdminRoutes } from './modules/admin/routes.js'
import { createAdminSettingsRoutes, createPublicSettingsRoutes } from './modules/settings/routes.js'
import type { AppEnv } from './types.js'

export const API_PREFIX = '/api/v1'

export function createApp() {
  const e = env()
  const app = new OpenAPIHono<AppEnv>({ defaultHook })

  app.onError(onError)
  app.notFound(onNotFound)

  app.use('*', requestId)
  if (!e.isTest) app.use('*', logger())
  app.use('*', secureHeaders())
  app.use(
    '*',
    cors({
      // Credentialed requests cannot use a wildcard origin — the allowlist is
      // the CORS_ORIGINS env var, one entry per deployed front end.
      origin: (origin) => (e.CORS_ORIGINS.includes(origin) ? origin : (e.CORS_ORIGINS[0] ?? '')),
      credentials: true,
      allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
      exposeHeaders: ['X-Request-Id', 'Retry-After']
    })
  )

  app.get('/health', (c) =>
    c.json({ ok: true, service: 'prison-commerce-api', env: e.NODE_ENV, now: Date.now() })
  )

  const api = new OpenAPIHono<AppEnv>({ defaultHook })

  /* customer realm */
  api.route(
    '/auth',
    createAuthRoutes({
      spec: customerRealm,
      provider: customerPasswordProvider,
      tag: 'auth',
      allowRegister: true
    })
  )
  api.route('/me', createMeRoutes())
  api.route('/prisons', createPrisonRoutes())
  // /shops, /categories, /products — browsing needs no session.
  api.route('/', createCatalogRoutes())
  api.route('/orders', createOrderRoutes())
  api.route('/payment-channels', createPaymentChannelRoutes())
  api.route('/payments', createPaymentRoutes())
  api.route('/deposit-cards', createDepositCardRoutes())
  api.route('/deposits', createDepositRoutes())
  api.route('/letter-packages', createLetterPackageRoutes())
  api.route('/letter-purchases', createLetterPurchaseRoutes())
  api.route('/letters', createLetterRoutes())
  api.route('/visits', createVisitRoutes())
  api.route('/settings', createPublicSettingsRoutes())

  /* staff realm — same session shape, separate cookie, separate route tree */
  api.route(
    '/admin/auth',
    createAuthRoutes({
      spec: staffRealm,
      provider: staffPasswordProvider,
      tag: 'admin:auth',
      allowRegister: false
    })
  )
  api.route('/admin/settings', createAdminSettingsRoutes())
  api.route('/admin', createAdminCatalogRoutes())
  api.route('/admin', createAdminOrderRoutes())
  api.route('/admin', createAdminInmateRoutes())
  api.route('/admin', createAdminPaymentRoutes())
  api.route('/admin', createAdminDepositRoutes())
  api.route('/admin', createAdminLetterRoutes())
  api.route('/admin', createAdminVisitRoutes())
  api.route('/admin', createAdminRoutes())

  app.route(API_PREFIX, api)

  // Local storage adapter serves uploads directly; in production Caddy does it.
  if (e.STORAGE_ADAPTER === 'local') {
    const rel = path.relative(process.cwd(), e.paths.uploads).split(path.sep).join('/')
    app.use(
      `${e.STORAGE_PUBLIC_PATH}/*`,
      serveStatic({
        root: rel || '.',
        rewriteRequestPath: (p) => p.replace(e.STORAGE_PUBLIC_PATH, '')
      })
    )
  }

  app.doc31(`${API_PREFIX}/openapi.json`, {
    openapi: '3.1.0',
    info: {
      title: 'ศูนย์บริการระบบโปรแกรมจำหน่ายสินค้าเรือนจำ — API',
      version: '0.1.0',
      description:
        'API เดียวที่แตะฐานข้อมูล ทุก endpoint ถูกจำกัดขอบเขตด้วย prison → zone ผ่าน middleware'
    },
    servers: [{ url: e.API_BASE_URL }]
  })
  app.openAPIRegistry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'JWT'
  })

  return app
}

export type App = ReturnType<typeof createApp>
