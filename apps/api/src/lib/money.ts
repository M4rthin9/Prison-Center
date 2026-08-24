/**
 * Money is INTEGER satang. Never float, never decimal-as-text.
 * 1 baht = 100 satang.
 */
export type Satang = number

export const baht = (b: number): Satang => Math.round(b * 100)

export function formatBaht(s: Satang, opts: { symbol?: boolean } = {}): string {
  const sign = s < 0 ? '-' : ''
  const abs = Math.abs(s)
  const body = (abs / 100).toLocaleString('th-TH', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  })
  return `${sign}${opts.symbol === false ? '' : '฿'}${body}`
}

export function assertSatang(value: number, label = 'amount'): Satang {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} must be an integer satang value`)
  return value
}

export const sumSatang = (values: Satang[]): Satang => values.reduce((a, b) => a + b, 0)
