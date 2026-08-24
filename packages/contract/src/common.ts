import { z } from 'zod'

/** Every non-2xx response from the API has exactly this shape. */
export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    /** Field-level validation detail, keyed by dotted path. */
    fields: z.record(z.string(), z.array(z.string())).optional()
  })
})
export type ApiError = z.infer<typeof ApiError>

export const ErrorCode = {
  BAD_REQUEST: 'BAD_REQUEST',
  UNAUTHORIZED: 'UNAUTHORIZED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  VALIDATION: 'VALIDATION',
  LOCKED_OUT: 'LOCKED_OUT',
  MUST_CHANGE_PASSWORD: 'MUST_CHANGE_PASSWORD',
  RATE_LIMITED: 'RATE_LIMITED',
  INTERNAL: 'INTERNAL'
} as const
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode]

/** ULID — 26 chars, Crockford base32. */
export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'invalid id')

/** Cursor pagination. `cursor` is opaque; do not parse it client-side. */
export const PageQuery = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20)
})
export type PageQuery = z.infer<typeof PageQuery>

export function pageOf<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), nextCursor: z.string().nullable() })
}

/**
 * Thai mobile numbers are the customer username. One canonical form: 0XXXXXXXXX.
 * Accepts 66-prefixed and separator-laden input, rejects everything else.
 */
export function normalizeThaiPhone(input: string): string | null {
  const digits = input.replace(/[\s\-().]/g, '').replace(/^\+/, '')
  let local = digits
  if (local.startsWith('66')) local = '0' + local.slice(2)
  if (!/^0[689]\d{8}$/.test(local)) return null
  return local
}

export const ThaiPhone = z
  .string()
  .transform((v, ctx) => {
    const n = normalizeThaiPhone(v)
    if (!n) {
      ctx.addIssue({ code: 'custom', message: 'เบอร์มือถือไม่ถูกต้อง' })
      return z.NEVER
    }
    return n
  })

/** OWASP-ish floor. Deliberately not a character-class maze — length is what matters. */
export const Password = z.string().min(8, 'รหัสผ่านอย่างน้อย 8 ตัวอักษร').max(200)
