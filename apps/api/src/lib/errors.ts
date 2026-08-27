import type { ContentfulStatusCode } from 'hono/utils/http-status'

export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'VALIDATION'
  | 'LOCKED_OUT'
  | 'MUST_CHANGE_PASSWORD'
  | 'LINE_NOT_LINKED'
  | 'RATE_LIMITED'
  | 'INTERNAL'

const STATUS: Record<ErrorCode, ContentfulStatusCode> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  VALIDATION: 422,
  LOCKED_OUT: 423,
  MUST_CHANGE_PASSWORD: 403,
  LINE_NOT_LINKED: 404,
  RATE_LIMITED: 429,
  INTERNAL: 500
}

export class AppError extends Error {
  readonly code: ErrorCode
  readonly status: ContentfulStatusCode
  readonly fields?: Record<string, string[]>
  /** Extra headers the error handler should set, e.g. Retry-After. */
  readonly headers?: Record<string, string>

  constructor(
    code: ErrorCode,
    message: string,
    opts: {
      fields?: Record<string, string[]>
      headers?: Record<string, string>
      cause?: unknown
    } = {}
  ) {
    super(message, { cause: opts.cause })
    this.name = 'AppError'
    this.code = code
    this.status = STATUS[code]
    this.fields = opts.fields
    this.headers = opts.headers
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.fields ? { fields: this.fields } : {})
      }
    }
  }
}

export const badRequest = (m: string, fields?: Record<string, string[]>) =>
  new AppError('BAD_REQUEST', m, { fields })
export const unauthorized = (m = 'ต้องเข้าสู่ระบบก่อน') => new AppError('UNAUTHORIZED', m)
export const forbidden = (m = 'ไม่มีสิทธิ์เข้าถึง') => new AppError('FORBIDDEN', m)
export const notFound = (m = 'ไม่พบข้อมูล') => new AppError('NOT_FOUND', m)
export const conflict = (m: string) => new AppError('CONFLICT', m)
export const rateLimited = (m: string, retryAfterSec: number) =>
  new AppError('RATE_LIMITED', m, { headers: { 'Retry-After': String(retryAfterSec) } })
