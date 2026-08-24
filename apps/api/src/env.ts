import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { z } from 'zod'

/** apps/api/ — every relative path in .env resolves against this, not cwd. */
export const APP_ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)))

const boolish = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())
    )

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  )

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  API_BASE_URL: z.string().default('http://localhost:8787'),
  CORS_ORIGINS: csv,

  DATABASE_PATH: z.string().default('./data/app.db'),

  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  ACCESS_TOKEN_TTL_MINUTES: z.coerce.number().int().min(1).max(120).default(15),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  COOKIE_SECURE: boolish(false),
  COOKIE_DOMAIN: z.string().optional(),

  STORAGE_ADAPTER: z.enum(['local', 's3']).default('local'),
  STORAGE_LOCAL_DIR: z.string().default('./data/uploads'),
  STORAGE_PUBLIC_PATH: z.string().default('/files'),
  S3_ENDPOINT: z.string().optional(),
  S3_REGION: z.string().optional(),
  S3_BUCKET: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),

  NOTIFIER_ADAPTER: z.enum(['console', 'in_app', 'line']).default('console'),
  NOTIFIER_OUTBOX_PATH: z.string().default('./data/outbox.log'),

  LINE_CHANNEL_ID: z.string().optional(),
  LINE_CHANNEL_SECRET: z.string().optional(),
  LINE_MESSAGING_TOKEN: z.string().optional()
})

const DEV_SECRET = 'dev-only-secret-change-me-dev-only-secret-change-me'

function load() {
  const parsed = EnvSchema.safeParse(process.env)
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`)
    throw new Error(`Invalid environment:\n${lines.join('\n')}`)
  }
  const env = parsed.data

  if (env.NODE_ENV === 'production') {
    if (env.JWT_SECRET === DEV_SECRET) throw new Error('JWT_SECRET is still the dev default')
    if (!env.COOKIE_SECURE) throw new Error('COOKIE_SECURE must be 1 in production')
    if (env.CORS_ORIGINS.length === 0) throw new Error('CORS_ORIGINS must be set in production')
  }

  // `:memory:` is a SQLite magic value, not a path — tests rely on it surviving.
  const abs = (p: string) =>
    p === ':memory:' ? p : path.isAbsolute(p) ? p : path.resolve(APP_ROOT, p)

  return {
    ...env,
    isProd: env.NODE_ENV === 'production',
    isTest: env.NODE_ENV === 'test',
    paths: {
      root: APP_ROOT,
      database: abs(env.DATABASE_PATH),
      uploads: abs(env.STORAGE_LOCAL_DIR),
      outbox: abs(env.NOTIFIER_OUTBOX_PATH),
      migrations: path.resolve(APP_ROOT, 'src/db/migrations')
    }
  }
}

export type Env = ReturnType<typeof load>

let cached: Env | null = null
export function env(): Env {
  return (cached ??= load())
}
