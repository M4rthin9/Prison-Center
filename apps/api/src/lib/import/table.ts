import ExcelJS from 'exceljs'
import { badRequest } from '../errors.js'

/**
 * One shape for every tabular upload: a header row and string cells. Numbers,
 * dates and formulas are flattened to text here so that nothing downstream has
 * to care whether the file was XLSX or CSV — the DOC export is whichever the
 * clerk happened to save that morning (§13 unknown #1).
 */
export interface ParsedTable {
  headers: string[]
  /** Keyed by header, in file order. Row 1 is the header, so data starts at 2. */
  rows: { rowNo: number; cells: Record<string, string> }[]
  format: 'xlsx' | 'csv'
  /** Only meaningful for CSV — XLSX is always UTF-8 internally. */
  encoding: 'utf-8' | 'windows-874'
}

export const MAX_IMPORT_BYTES = 10 * 1024 * 1024

const XLSX_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04])

/* ── text decoding ─────────────────────────────────────────────────────── */

/**
 * TIS-620 is still what a lot of Thai government exports produce. UTF-8 is
 * tried first and only accepted if it round-trips: a mis-decoded Thai byte
 * yields U+FFFD, which is the signal to fall back rather than import mojibake.
 */
function decodeText(buf: Buffer): { text: string; encoding: ParsedTable['encoding'] } {
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { text: buf.subarray(3).toString('utf8'), encoding: 'utf-8' }
  }
  const utf8 = new TextDecoder('utf-8', { fatal: false }).decode(buf)
  if (!utf8.includes('�')) return { text: utf8, encoding: 'utf-8' }
  return { text: new TextDecoder('windows-874').decode(buf), encoding: 'windows-874' }
}

/** Comma, semicolon, tab or pipe — decided by whichever is most consistent. */
function sniffDelimiter(sample: string): string {
  const candidates = [',', ';', '\t', '|']
  const line = sample.split(/\r?\n/).find((l) => l.trim() !== '') ?? ''
  let best = ','
  let bestCount = 0
  for (const d of candidates) {
    const count = line.split(d).length - 1
    if (count > bestCount) {
      best = d
      bestCount = count
    }
  }
  return best
}

/** RFC 4180: quoted fields may contain the delimiter, newlines and `""`. */
function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"' && field === '') {
      quoted = true
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else if (ch !== '\r') {
      field += ch
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/* ── cell normalisation ────────────────────────────────────────────────── */

const THAI_DIGITS = '๐๑๒๓๔๕๖๗๘๙'

/** Thai numerals appear in hand-maintained sheets; store Arabic ones. */
export function normalizeCell(value: string): string {
  let out = ''
  for (const ch of value) {
    const idx = THAI_DIGITS.indexOf(ch)
    out += idx >= 0 ? String(idx) : ch
  }
  // Collapse every run of whitespace (including the Thai NBSP families).
  return out.replace(/\s+/g, ' ').trim()
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return ''
  if (value instanceof Date) return value.toISOString().slice(0, 10)
  if (typeof value === 'object') {
    const v = value as unknown as Record<string, unknown>
    if ('text' in v) return String(v.text ?? '')
    if ('result' in v) return String(v.result ?? '')
    if ('richText' in v && Array.isArray(v.richText)) {
      return (v.richText as { text: string }[]).map((r) => r.text).join('')
    }
    if ('hyperlink' in v) return String(v.text ?? v.hyperlink ?? '')
    return ''
  }
  return String(value)
}

/* ── entry point ───────────────────────────────────────────────────────── */

function toTable(
  grid: string[][],
  format: ParsedTable['format'],
  encoding: ParsedTable['encoding']
): ParsedTable {
  // Sheets often carry a merged title row above the real header. The header is
  // the first row with two or more non-empty cells.
  const headerIdx = grid.findIndex((r) => r.filter((c) => c.trim() !== '').length >= 2)
  if (headerIdx < 0) throw badRequest('ไม่พบแถวหัวตารางในไฟล์ที่อัปโหลด')

  const seen = new Map<string, number>()
  const headers = grid[headerIdx]!.map((h, i) => {
    const name = normalizeCell(h) || `คอลัมน์ ${i + 1}`
    // Duplicate headers would silently overwrite each other in the row object.
    const n = (seen.get(name) ?? 0) + 1
    seen.set(name, n)
    return n === 1 ? name : `${name} (${n})`
  })

  const rows: ParsedTable['rows'] = []
  for (let i = headerIdx + 1; i < grid.length; i++) {
    const raw = grid[i]!
    if (raw.every((c) => c.trim() === '')) continue
    const cells: Record<string, string> = {}
    headers.forEach((h, idx) => {
      cells[h] = normalizeCell(raw[idx] ?? '')
    })
    rows.push({ rowNo: i + 1, cells })
  }

  if (rows.length === 0) throw badRequest('ไฟล์นี้ไม่มีข้อมูลผู้ต้องขังสักแถว')
  return { headers, rows, format, encoding }
}

export async function parseTable(buffer: Buffer, filename?: string): Promise<ParsedTable> {
  if (buffer.byteLength === 0) throw badRequest('ไฟล์ว่าง')
  if (buffer.byteLength > MAX_IMPORT_BYTES) throw badRequest('ไฟล์ใหญ่เกิน 10 MB')

  const looksXlsx = buffer.subarray(0, 4).equals(XLSX_MAGIC)
  const named = (filename ?? '').toLowerCase()
  if (named.endsWith('.xls') && !looksXlsx) {
    throw badRequest('ไฟล์ .xls รุ่นเก่ายังไม่รองรับ กรุณาบันทึกใหม่เป็น .xlsx หรือ .csv')
  }

  if (looksXlsx) {
    const wb = new ExcelJS.Workbook()
    // `as never`: exceljs types the loader for the DOM ArrayBuffer only.
    await wb.xlsx.load(buffer as never)
    const sheet = wb.worksheets.find((s) => s.rowCount > 0) ?? wb.worksheets[0]
    if (!sheet) throw badRequest('ไฟล์ Excel นี้ไม่มีชีตข้อมูล')

    const grid: string[][] = []
    sheet.eachRow({ includeEmpty: true }, (row) => {
      const values = row.values as ExcelJS.CellValue[]
      // exceljs indexes cells from 1; index 0 is always empty.
      grid.push(values.slice(1).map(cellText))
    })
    return toTable(grid, 'xlsx', 'utf-8')
  }

  const { text, encoding } = decodeText(buffer)
  return toTable(parseCsv(text, sniffDelimiter(text)), 'csv', encoding)
}
