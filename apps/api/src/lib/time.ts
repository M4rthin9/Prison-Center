export const SECOND = 1000
export const MINUTE = 60 * SECOND
export const HOUR = 60 * MINUTE
export const DAY = 24 * HOUR

export const now = () => Date.now()

/** Asia/Bangkok is UTC+7 year-round — no DST, so a fixed offset is correct. */
export const BANGKOK_OFFSET_MS = 7 * HOUR

/** `YYYY-MM-DD` in Bangkok local time, from a UTC epoch-ms value. */
export function bangkokDate(tsMs: number = now()): string {
  return new Date(tsMs + BANGKOK_OFFSET_MS).toISOString().slice(0, 10)
}

/** `YYYY-MM` in Bangkok local time — the grouping key for every period report. */
export function bangkokMonth(tsMs: number = now()): string {
  return bangkokDate(tsMs).slice(0, 7)
}

/** Buddhist-era year. A *formatting* concern only — never stored. */
export const buddhistYear = (tsMs: number = now()) =>
  new Date(tsMs + BANGKOK_OFFSET_MS).getUTCFullYear() + 543
