import type { Context, ErrorHandler, NotFoundHandler } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { ZodError } from 'zod'
import { AppError } from '../lib/errors.js'
import { env } from '../env.js'

function fieldsFromZod(err: ZodError): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const issue of err.issues) {
    const key = issue.path.join('.') || '_'
    ;(out[key] ??= []).push(issue.message)
  }
  return out
}

/** Every non-2xx response in this API has the same body shape. */
export const onError: ErrorHandler = (err, c: Context) => {
  if (err instanceof AppError) {
    for (const [k, v] of Object.entries(err.headers ?? {})) c.header(k, v)
    return c.json(err.toJSON(), err.status)
  }

  if (err instanceof ZodError) {
    return c.json(
      { error: { code: 'VALIDATION', message: 'ข้อมูลไม่ถูกต้อง', fields: fieldsFromZod(err) } },
      422
    )
  }

  if (err instanceof HTTPException) {
    const code = err.status === 401 ? 'UNAUTHORIZED' : err.status === 403 ? 'FORBIDDEN' : 'BAD_REQUEST'
    return c.json({ error: { code, message: err.message } }, err.status)
  }

  // Anything reaching here is a bug — log it with the request id and say nothing
  // useful to the caller.
  console.error(`[error] ${c.get('requestId') ?? '-'} ${c.req.method} ${c.req.path}`, err)
  return c.json(
    {
      error: {
        code: 'INTERNAL',
        message: env().isProd ? 'เกิดข้อผิดพลาดภายในระบบ' : String((err as Error)?.message ?? err)
      }
    },
    500
  )
}

export const onNotFound: NotFoundHandler = (c) =>
  c.json({ error: { code: 'NOT_FOUND', message: `ไม่พบเส้นทาง ${c.req.path}` } }, 404)
