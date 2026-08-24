import type { Hook } from '@hono/zod-openapi'
import { AppError } from './errors.js'

/**
 * Turns @hono/zod-openapi's validation failures into the same error envelope
 * every other failure uses. Without this the API would have two error shapes.
 */
export const defaultHook: Hook<any, any, any, any> = (result) => {
  if (result.success) return
  const fields: Record<string, string[]> = {}
  for (const issue of result.error.issues) {
    const key = issue.path.join('.') || '_'
    ;(fields[key] ??= []).push(issue.message)
  }
  throw new AppError('VALIDATION', 'ข้อมูลไม่ถูกต้อง', { fields })
}
