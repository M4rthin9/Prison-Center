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

/** Epoch ms for a Bangkok wall-clock `YYYY-MM-DD` + `HH:MM` (§4.6 rounds). */
export function bangkokEpoch(date: string, time = '00:00'): number {
  return Date.parse(`${date}T${time}:00+07:00`)
}

/** 0 = Sunday. Reads the date string itself, so it never drifts by a timezone. */
export function weekdayOf(date: string): number {
  return new Date(`${date}T00:00:00Z`).getUTCDay()
}

/** `YYYY-MM-DD` n days after (or before) another `YYYY-MM-DD`. */
export function addDays(date: string, n: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10)
}

/** Inclusive list of `YYYY-MM-DD` from `from` to `to`. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = []
  for (let d = from; d <= to; d = addDays(d, 1)) {
    out.push(d)
    if (out.length > 400) break // a runaway range is a bug, not a report
  }
  return out
}
