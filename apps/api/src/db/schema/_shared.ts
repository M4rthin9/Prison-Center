import { integer, text } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'
import { ulid } from 'ulid'

/** ULID: sortable, opaque, no cross-prison enumeration signal. */
export const id = () =>
  text('id')
    .primaryKey()
    .$defaultFn(() => ulid())

/** Unix epoch **milliseconds, UTC**. Converted to Asia/Bangkok at the display edge only. */
export const ts = (name: string) => integer(name, { mode: 'number' })

export const createdAt = () =>
  ts('created_at')
    .notNull()
    .$defaultFn(() => Date.now())

export const updatedAt = () =>
  ts('updated_at')
    .notNull()
    .$defaultFn(() => Date.now())
    .$onUpdateFn(() => Date.now())

export const timestamps = () => ({ createdAt: createdAt(), updatedAt: updatedAt() })

/**
 * SQLite has no boolean; 0/1 with an explicit default keeps migrations readable.
 * The default is required so the column is optional on insert.
 */
export const bool = (name: string, def: boolean) =>
  integer(name, { mode: 'boolean' }).notNull().default(def)

/** Money is INTEGER satang, everywhere, always. */
export const satang = (name: string) => integer(name, { mode: 'number' })

export const jsonText = <T>(name: string) => text(name, { mode: 'json' }).$type<T>()

export const nowSql = sql`(unixepoch('subsec') * 1000)`
