import { beforeAll } from 'vitest'

/**
 * Every integration test runs against a real SQLite database with the real
 * migrations applied — in memory, so a suite costs milliseconds and nothing
 * leaks between files. Env must be set before any module reads it.
 */
process.env.NODE_ENV = 'test'
process.env.DATABASE_PATH = ':memory:'
process.env.JWT_SECRET ??= 'test-secret-test-secret-test-secret-test-secret'
process.env.CORS_ORIGINS ??= 'http://localhost:5173'
process.env.NOTIFIER_ADAPTER = 'in_app'
process.env.ACCESS_TOKEN_TTL_MINUTES ??= '15'

const { createApp } = await import('../src/app.js')
const { db, runMigrations } = await import('../src/db/client.js')
const { seed } = await import('../src/db/seed/index.js')

export type TestApp = ReturnType<typeof createApp>

export interface TestClient {
  app: TestApp
  /** Bearer token used for subsequent requests. */
  token: string | null
  /** Minimal cookie jar so rotating-refresh flows can be exercised. */
  cookies: Map<string, string>
  request(path: string, init?: RequestInit & { json?: unknown; auth?: boolean }): Promise<Response>
  json<T>(path: string, init?: RequestInit & { json?: unknown; auth?: boolean }): Promise<T>
}

export const BASE = '/api/v1'

let clientSeq = 0

export function createClient(app: TestApp): TestClient {
  // Each client gets its own source IP so the per-IP login throttle isolates
  // tests instead of leaking a shared counter across the file.
  const ip = `10.0.0.${++clientSeq % 250}`
  const client: TestClient = {
    app,
    token: null,
    cookies: new Map(),

    async request(path, init = {}) {
      const headers = new Headers(init.headers)
      if (init.json !== undefined) {
        headers.set('content-type', 'application/json')
      }
      if (init.auth !== false && client.token) {
        headers.set('authorization', `Bearer ${client.token}`)
      }
      headers.set('x-forwarded-for', ip)
      if (client.cookies.size > 0) {
        headers.set('cookie', [...client.cookies].map(([k, v]) => `${k}=${v}`).join('; '))
      }

      const res = await app.request(`http://localhost${path}`, {
        ...init,
        headers,
        body: init.json !== undefined ? JSON.stringify(init.json) : init.body
      })

      for (const raw of res.headers.getSetCookie?.() ?? []) {
        const [pair] = raw.split(';')
        const idx = pair!.indexOf('=')
        const name = pair!.slice(0, idx)
        const value = pair!.slice(idx + 1)
        if (value === '' || /Max-Age=0/i.test(raw)) client.cookies.delete(name)
        else client.cookies.set(name, value)
      }
      return res
    },

    async json<T>(path: string, init: RequestInit & { json?: unknown; auth?: boolean } = {}) {
      const res = await client.request(path, init)
      return (await res.json()) as T
    }
  }
  return client
}

export interface SeededApp {
  app: TestApp
  client(): TestClient
}

/** One migrated + seeded in-memory database per test file. */
export function setupApp(): SeededApp {
  let app: TestApp

  beforeAll(async () => {
    runMigrations(db())
    await seed(db())
    app = createApp()
  })

  return {
    get app() {
      return app
    },
    client: () => createClient(app)
  }
}

export const DEV_PASSWORD = 'password123'

export async function loginCustomer(
  app: TestApp,
  username = '0812345678',
  password = DEV_PASSWORD
) {
  const client = createClient(app)
  const res = await client.request(`${BASE}/auth/login`, {
    method: 'POST',
    json: { username, password }
  })
  const body = (await res.json()) as { accessToken?: string; mustChangePassword?: boolean }
  if (body.accessToken) client.token = body.accessToken
  return { client, status: res.status, body }
}

export async function loginStaff(app: TestApp, username = 'superadmin', password = DEV_PASSWORD) {
  const client = createClient(app)
  const res = await client.request(`${BASE}/admin/auth/login`, {
    method: 'POST',
    json: { username, password }
  })
  const body = (await res.json()) as { accessToken?: string; mustChangePassword?: boolean }
  if (body.accessToken) client.token = body.accessToken
  return { client, status: res.status, body }
}
