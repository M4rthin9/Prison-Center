import { badRequest } from './errors.js'

/**
 * Keyset pagination. The cursor is an opaque encoding of the last row's sort
 * key — never an offset, because a list that shifts under the reader would
 * silently skip rows.
 */
export function encodeCursor(parts: (string | number)[]): string {
  return Buffer.from(JSON.stringify(parts), 'utf8').toString('base64url')
}

export function decodeCursor(cursor: string | undefined | null): (string | number)[] | null {
  if (!cursor) return null
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
    if (!Array.isArray(parsed)) throw new Error('not a tuple')
    return parsed as (string | number)[]
  } catch {
    throw badRequest('ตัวชี้หน้าถัดไปไม่ถูกต้อง')
  }
}

/**
 * Rows are fetched with `limit + 1`; the extra row is the proof there is a
 * next page and is dropped from the response.
 */
export function paginate<T>(rows: T[], limit: number, key: (row: T) => (string | number)[]) {
  const hasMore = rows.length > limit
  const items = hasMore ? rows.slice(0, limit) : rows
  const last = items.at(-1)
  return {
    items,
    nextCursor: hasMore && last ? encodeCursor(key(last)) : null
  }
}
