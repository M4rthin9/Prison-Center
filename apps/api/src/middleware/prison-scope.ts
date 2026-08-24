import { eq, type SQL } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import { forbidden } from '../lib/errors.js'
import type { StaffPrincipal } from '../types.js'

/**
 * Everything in this system is sliced by prison → zone. Scoping is not a
 * `where` clause you remember to write: every admin query helper takes a
 * PrisonScope, so forgetting it is a type error.
 *
 * `null` means department-wide — super_admin only.
 */
export type PrisonScope = { kind: 'all' } | { kind: 'prison'; prisonId: string }

export function prisonScope(staff: StaffPrincipal | undefined): PrisonScope {
  if (!staff) throw forbidden()
  if (staff.role === 'super_admin') return { kind: 'all' }
  if (!staff.prisonId) throw forbidden('บัญชีเจ้าหน้าที่นี้ยังไม่ได้ผูกกับเรือนจำ')
  return { kind: 'prison', prisonId: staff.prisonId }
}

/** Adds the scope predicate to a query. Pass the table's `prison_id` column. */
export function scopeFilter(scope: PrisonScope, column: SQLiteColumn): SQL | undefined {
  return scope.kind === 'all' ? undefined : eq(column, scope.prisonId)
}

/**
 * Guards a prison id supplied by the client (a query param, a body field).
 * super_admin may target any prison; everyone else is pinned to their own.
 */
export function resolvePrisonId(scope: PrisonScope, requested?: string | null): string | null {
  if (scope.kind === 'all') return requested ?? null
  if (requested && requested !== scope.prisonId) {
    throw forbidden('ไม่มีสิทธิ์เข้าถึงข้อมูลของเรือนจำอื่น')
  }
  return scope.prisonId
}

/** Throws unless the row being touched belongs to the caller's prison. */
export function assertInScope(scope: PrisonScope, rowPrisonId: string | null | undefined) {
  if (scope.kind === 'all') return
  if (rowPrisonId !== scope.prisonId) throw forbidden('ไม่มีสิทธิ์เข้าถึงข้อมูลของเรือนจำอื่น')
}
