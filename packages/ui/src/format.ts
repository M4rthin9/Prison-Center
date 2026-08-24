/**
 * Display-edge conversions. Storage stays UTC epoch-ms and integer satang;
 * everything Thai-facing is formatted here and nowhere else.
 */

const BANGKOK = 'Asia/Bangkok'

export function formatBaht(satang: number, opts: { symbol?: boolean } = {}): string {
  const sign = satang < 0 ? '-' : ''
  const body = (Math.abs(satang) / 100).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })
  return `${sign}${opts.symbol === false ? '' : '฿'}${body}`
}

export function formatDateTime(tsMs: number | null | undefined): string {
  if (!tsMs) return '—'
  return new Intl.DateTimeFormat('th-TH', {
    timeZone: BANGKOK,
    dateStyle: 'medium',
    timeStyle: 'short'
  }).format(new Date(tsMs))
}

export function formatDate(tsMs: number | null | undefined): string {
  if (!tsMs) return '—'
  return new Intl.DateTimeFormat('th-TH', { timeZone: BANGKOK, dateStyle: 'medium' }).format(
    new Date(tsMs)
  )
}

export function formatRelative(tsMs: number | null | undefined): string {
  if (!tsMs) return '—'
  const diff = tsMs - Date.now()
  const abs = Math.abs(diff)
  const rtf = new Intl.RelativeTimeFormat('th-TH', { numeric: 'auto' })
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000]
  ]
  for (const [unit, ms] of units) {
    if (abs >= ms) return rtf.format(Math.round(diff / ms), unit)
  }
  return rtf.format(Math.round(diff / 1000), 'second')
}

/** 0812345678 → 081-234-5678 */
export function formatPhone(phone: string): string {
  return /^0\d{9}$/.test(phone) ? `${phone.slice(0, 3)}-${phone.slice(3, 6)}-${phone.slice(6)}` : phone
}
