import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import { and, desc, eq } from 'drizzle-orm'
import {
  REPORT_LABEL,
  ReportKind,
  ReportRequestInput,
  type ReportJob,
  type ReportJobStatus
} from '@pc/contract'
import { db as defaultDb, sqlite as defaultSqlite, type Db, type Sqlite } from '../../db/client.js'
import { jobs, prisons, staff } from '../../db/schema/index.js'
import { writeAudit } from '../../lib/audit.js'
import { badRequest, forbidden, notFound } from '../../lib/errors.js'
import { enqueue } from '../../lib/jobs/queue.js'
import { storage } from '../../lib/storage/index.js'
import { bangkokEpoch, BANGKOK_OFFSET_MS, buddhistYear, DAY } from '../../lib/time.js'
import type { PrisonScope } from '../../middleware/prison-scope.js'
import { REPORTS, type ReportColumn, type ReportDefinition } from './definitions.js'

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const QUERY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'queries')

/** Read once, keep forever: the files are part of the deployed image. */
const sqlCache = new Map<ReportKind, string>()

export function reportSql(kind: ReportKind): string {
  let text = sqlCache.get(kind)
  if (!text) {
    text = fs.readFileSync(path.join(QUERY_DIR, `${kind}.sql`), 'utf8')
    sqlCache.set(kind, text)
  }
  return text
}

/* ── running one report ────────────────────────────────────────────────── */

export interface ReportParams {
  prison_id: string | null
  zone_id: string | null
  shop_id: string | null
  from_ms: number
  to_ms: number
  from_date: string
  to_date: string
  group_fmt: string
}

export function reportParams(filters: ReportRequestInput, prisonId: string | null): ReportParams {
  if (filters.from > filters.to) throw badRequest('วันเริ่มต้นต้องไม่หลังวันสิ้นสุด')
  return {
    prison_id: prisonId,
    zone_id: filters.zoneId ?? null,
    shop_id: filters.shopId ?? null,
    from_ms: bangkokEpoch(filters.from),
    // Inclusive of the last day, to the last millisecond before the next one.
    to_ms: bangkokEpoch(filters.to) + DAY - 1,
    from_date: filters.from,
    to_date: filters.to,
    group_fmt: filters.groupBy === 'month' ? '%Y-%m' : filters.groupBy === 'year' ? '%Y' : 'all'
  }
}

/**
 * better-sqlite3 rejects a bind object carrying a name the statement never
 * mentions, and not every report needs every filter — so the parameter set is
 * derived from the SQL text itself.
 */
function bindFor(sql: string, params: ReportParams): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(params)) {
    if (new RegExp(`:${key}\\b`).test(sql)) out[key] = value
  }
  return out
}

export function runReportQuery(
  kind: ReportKind,
  params: ReportParams,
  handle: Sqlite = defaultSqlite()
): Record<string, unknown>[] {
  const sql = reportSql(kind)
  return handle.prepare(sql).all(bindFor(sql, params)) as Record<string, unknown>[]
}

/* ── formatting ────────────────────────────────────────────────────────── */

const THAI_MONTH = [
  'ม.ค.',
  'ก.พ.',
  'มี.ค.',
  'เม.ย.',
  'พ.ค.',
  'มิ.ย.',
  'ก.ค.',
  'ส.ค.',
  'ก.ย.',
  'ต.ค.',
  'พ.ย.',
  'ธ.ค.'
]

/** Buddhist-era years are a formatting concern — never stored (§7). */
export function thaiDateTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '-'
  const d = new Date(ms + BANGKOK_OFFSET_MS)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${buddhistYear(ms)} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

/** `2026-08` → `ส.ค. 2569`; `2026` → `2569`; anything else passes through. */
export function thaiPeriod(value: unknown): string {
  const text = String(value ?? '')
  const month = /^(\d{4})-(\d{2})$/.exec(text)
  if (month) return `${THAI_MONTH[Number(month[2]) - 1] ?? month[2]} ${Number(month[1]) + 543}`
  const year = /^(\d{4})$/.exec(text)
  if (year) return String(Number(year[1]) + 543)
  return text
}

function cellValue(column: ReportColumn, raw: unknown) {
  switch (column.format) {
    case 'money':
      // Satang integers become baht at the display edge, and nowhere else.
      return typeof raw === 'number' ? raw / 100 : 0
    case 'datetime':
      return thaiDateTime(typeof raw === 'number' ? raw : null)
    case 'period':
      return thaiPeriod(raw)
    case 'int':
      return typeof raw === 'number' ? raw : Number(raw ?? 0)
    default:
      return raw ?? '-'
  }
}

/* ── the workbook ──────────────────────────────────────────────────────── */

export interface WorkbookMeta {
  prisonName: string | null
  requestedBy: string | null
  generatedAt: number
}

function filterLine(filters: ReportRequestInput, meta: WorkbookMeta): string {
  const parts = [
    `เรือนจำ: ${meta.prisonName ?? 'ทุกเรือนจำ'}`,
    `ช่วงวันที่: ${filters.from} ถึง ${filters.to}`,
    `จัดกลุ่ม: ${filters.groupBy === 'month' ? 'รายเดือน' : filters.groupBy === 'year' ? 'รายปี' : 'ทั้งช่วง'}`
  ]
  if (filters.zoneId) parts.push(`แดน: ${filters.zoneId}`)
  if (filters.shopId) parts.push(`ร้านค้า: ${filters.shopId}`)
  return parts.join(' · ')
}

export async function buildWorkbook(
  def: ReportDefinition,
  rows: Record<string, unknown>[],
  filters: ReportRequestInput,
  meta: WorkbookMeta
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.created = new Date(meta.generatedAt)
  const sheet = wb.addWorksheet(def.sheet, {
    views: [{ state: 'frozen', ySplit: headerRowNumber(def) }]
  })

  const lastCol = def.columns.length + 1 // +1 for the ลำดับ column

  // Title block: what this is, what produced it, and when — every printed copy
  // has to be reproducible from its own first three rows.
  sheet.mergeCells(1, 1, 1, lastCol)
  const title = sheet.getCell(1, 1)
  title.value = def.title
  title.font = { bold: true, size: 16 }

  sheet.mergeCells(2, 1, 2, lastCol)
  sheet.getCell(2, 1).value = filterLine(filters, meta)
  sheet.getCell(2, 1).font = { size: 10 }

  sheet.mergeCells(3, 1, 3, lastCol)
  sheet.getCell(3, 1).value =
    `ออกรายงานเมื่อ ${thaiDateTime(meta.generatedAt)} น.` +
    (meta.requestedBy ? ` · โดย ${meta.requestedBy}` : '') +
    (def.note ? ` · ${def.note}` : '')
  sheet.getCell(3, 1).font = { size: 10, italic: true }

  const headerRow = sheet.getRow(headerRowNumber(def))
  headerRow.values = ['ลำดับ', ...def.columns.map((c) => c.header)]
  headerRow.font = { bold: true }
  headerRow.alignment = { vertical: 'middle', wrapText: true }
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFEFF3F8' } }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFBFCAD6' } } }
  })

  // Widths are set per column rather than by assigning `sheet.columns`, which
  // would clear the title block already written above.
  sheet.getColumn(1).width = 7
  def.columns.forEach((c, idx) => (sheet.getColumn(idx + 2).width = c.width))

  rows.forEach((row, i) => {
    const values = [i + 1, ...def.columns.map((c) => cellValue(c, row[c.key]))]
    const added = sheet.addRow(values)
    def.columns.forEach((c, idx) => {
      const cell = added.getCell(idx + 2)
      if (c.format === 'money') cell.numFmt = '#,##0.00'
      if (c.format === 'int') cell.numFmt = '#,##0'
    })
  })

  if (rows.length > 0 && def.totals.length > 0) {
    const totals = sheet.addRow([
      'รวม',
      ...def.columns.map((c) =>
        def.totals.includes(c.key)
          ? rows.reduce((acc, r) => acc + Number(r[c.key] ?? 0), 0) / (c.format === 'money' ? 100 : 1)
          : ''
      )
    ])
    totals.font = { bold: true }
    def.columns.forEach((c, idx) => {
      if (!def.totals.includes(c.key)) return
      const cell = totals.getCell(idx + 2)
      cell.numFmt = c.format === 'money' ? '#,##0.00' : '#,##0'
    })
    totals.eachCell((cell) => {
      cell.border = { top: { style: 'thin', color: { argb: 'FFBFCAD6' } } }
    })
  } else if (rows.length === 0) {
    // An empty sheet with only headers reads like a bug. Say so instead.
    const empty = sheet.addRow(['—', 'ไม่พบข้อมูลในช่วงเวลาที่เลือก'])
    empty.font = { italic: true }
  }

  sheet.autoFilter = {
    from: { row: headerRowNumber(def), column: 1 },
    to: { row: headerRowNumber(def), column: lastCol }
  }

  return Buffer.from(await wb.xlsx.writeBuffer())
}

const headerRowNumber = (_def: ReportDefinition) => 5

/* ── the job ───────────────────────────────────────────────────────────── */

interface ReportPayload {
  kind: ReportKind
  filters: ReportRequestInput
  prisonId: string | null
  requestedBy: string | null
  requestedByName: string | null
}

interface ReportResult {
  fileKey: string
  filename: string
  rowCount: number
  bytes: number
}

export function requestReport(
  actorId: string,
  kind: ReportKind,
  filters: ReportRequestInput,
  prisonId: string | null,
  ctx: { ip?: string | null; userAgent?: string | null } = {},
  database: Db = defaultDb()
): ReportJob {
  // Validates the range before a job row exists — a queued job that can only
  // fail is worse than a 400.
  reportParams(filters, prisonId)

  // The name is stamped into the payload so the sheet still says who ran it
  // after that staff account is deactivated.
  const requestedByName =
    database.select({ name: staff.fullName }).from(staff).where(eq(staff.id, actorId)).get()?.name ??
    null

  const payload: ReportPayload = {
    kind,
    filters,
    prisonId,
    requestedBy: actorId,
    requestedByName
  }
  // One attempt: a report that failed on bad SQL will fail identically four
  // more times, and the staff member is watching the row.
  const id = enqueue('report.generate', payload as unknown as Record<string, unknown>, {
    maxAttempts: 1,
    db: database
  })

  writeAudit(
    {
      actorType: 'staff',
      actorId,
      action: 'report.request',
      entity: 'report',
      entityId: id,
      prisonId,
      after: { kind, ...filters },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )
  return reportJob(id, database)
}

/** The `report.generate` handler (registered in lib/jobs/scheduler.ts). */
export async function generateReport(
  jobId: string,
  database: Db = defaultDb(),
  handle: Sqlite = defaultSqlite()
): Promise<ReportResult> {
  const row = database.select().from(jobs).where(eq(jobs.id, jobId)).get()
  if (!row) throw notFound('ไม่พบงานสร้างรายงาน')
  const payload = row.payloadJson as unknown as ReportPayload | undefined
  const def = payload?.kind ? REPORTS[payload.kind] : undefined
  if (!def || !payload?.filters) {
    throw badRequest(`งานสร้างรายงานนี้ไม่มีข้อมูลตัวกรองที่ใช้ได้ (kind="${payload?.kind ?? '-'}")`)
  }

  const rows = runReportQuery(payload.kind, reportParams(payload.filters, payload.prisonId), handle)
  const generatedAt = Date.now()
  const prisonName = payload.prisonId
    ? (database
        .select({ name: prisons.nameTh })
        .from(prisons)
        .where(eq(prisons.id, payload.prisonId))
        .get()?.name ?? null)
    : null

  const buffer = await buildWorkbook(def, rows, payload.filters, {
    prisonName,
    requestedBy: payload.requestedByName,
    generatedAt
  })
  const filename = `${def.title}-${payload.filters.from}-${payload.filters.to}.xlsx`
  const stored = await storage().put(buffer, {
    prefix: 'reports',
    filename,
    contentType: XLSX_MIME
  })

  return { fileKey: stored.key, filename, rowCount: rows.length, bytes: buffer.byteLength }
}

/* ── reading job rows back ─────────────────────────────────────────────── */

function parseResult(json: string | null): ReportResult | null {
  if (!json) return null
  try {
    return JSON.parse(json) as ReportResult
  } catch {
    return null
  }
}

type JobRow = typeof jobs.$inferSelect

export function toReportJob(row: JobRow): ReportJob {
  const payload = (row.payloadJson ?? {}) as unknown as ReportPayload
  const result = parseResult(row.resultJson)
  return {
    id: row.id,
    kind: payload.kind,
    label: REPORT_LABEL[payload.kind] ?? payload.kind,
    status: row.status as ReportJobStatus,
    filters: payload.filters,
    prisonId: payload.prisonId ?? null,
    requestedBy: payload.requestedByName ?? null,
    filename: result?.filename ?? null,
    rowCount: result?.rowCount ?? null,
    bytes: result?.bytes ?? null,
    error: row.lastError,
    createdAt: row.createdAt,
    completedAt: row.completedAt
  }
}

function jobRow(id: string, database: Db): JobRow {
  const row = database
    .select()
    .from(jobs)
    .where(and(eq(jobs.id, id), eq(jobs.kind, 'report.generate')))
    .get()
  if (!row) throw notFound('ไม่พบงานสร้างรายงาน')
  return row
}

/** A report carries one prison's rows; reading it is reading that prison. */
function assertReportScope(scope: PrisonScope, row: JobRow) {
  if (scope.kind === 'all') return
  const payload = (row.payloadJson ?? {}) as unknown as ReportPayload
  if (payload.prisonId !== scope.prisonId) {
    throw forbidden('ไม่มีสิทธิ์เข้าถึงรายงานของเรือนจำอื่น')
  }
}

export function reportJob(id: string, database: Db = defaultDb()): ReportJob {
  return toReportJob(jobRow(id, database))
}

export function scopedReportJob(
  scope: PrisonScope,
  id: string,
  database: Db = defaultDb()
): ReportJob {
  const row = jobRow(id, database)
  assertReportScope(scope, row)
  return toReportJob(row)
}

export function listReportJobs(
  scope: PrisonScope,
  opts: { kind?: ReportKind; limit?: number } = {},
  database: Db = defaultDb()
): ReportJob[] {
  const rows = database
    .select()
    .from(jobs)
    .where(eq(jobs.kind, 'report.generate'))
    .orderBy(desc(jobs.createdAt), desc(jobs.id))
    .limit(Math.min(opts.limit ?? 25, 100) * (scope.kind === 'all' ? 1 : 4))
    .all()

  return rows
    .map(toReportJob)
    .filter((j) => (scope.kind === 'all' || j.prisonId === scope.prisonId) && (!opts.kind || j.kind === opts.kind))
    .slice(0, Math.min(opts.limit ?? 25, 100))
}

export async function readReportFile(
  scope: PrisonScope,
  id: string,
  database: Db = defaultDb()
): Promise<{ body: Buffer; filename: string; contentType: string }> {
  const row = jobRow(id, database)
  assertReportScope(scope, row)
  const result = parseResult(row.resultJson)
  if (row.status !== 'succeeded' || !result) {
    throw badRequest(
      row.status === 'failed' ? 'สร้างรายงานไม่สำเร็จ' : 'รายงานยังสร้างไม่เสร็จ กรุณารอสักครู่'
    )
  }
  return {
    body: await storage().get(result.fileKey),
    filename: result.filename,
    contentType: XLSX_MIME
  }
}

export { REPORTS, ReportKind }
