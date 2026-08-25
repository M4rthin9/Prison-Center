import { createHash } from 'node:crypto'
import ExcelJS from 'exceljs'
import { and, asc, desc, eq, inArray, isNull, notInArray, type SQL } from 'drizzle-orm'
import type {
  ImportOptions,
  ImportPreview,
  ImportRowResult,
  ImportRunSummary
} from '@pc/contract'
import { db as defaultDb, type Db, type DbOrTx } from '../../db/client.js'
import {
  inmateImportRows,
  inmateImportRuns,
  inmates,
  prisons,
  staff,
  zones,
  type InmateStatus
} from '../../db/schema/index.js'
import { writeAudit } from '../../lib/audit.js'
import { badRequest, conflict, notFound } from '../../lib/errors.js'
import { storage } from '../../lib/storage/index.js'
import { now } from '../../lib/time.js'
import { parseTable, type ParsedTable } from '../../lib/import/table.js'
import {
  createWorkDivision,
  createZone,
  findByCode,
  findByExternalId,
  findWorkDivisionId,
  findZoneId
} from './service.js'

/* ── column mapping ────────────────────────────────────────────────────── */

export type Field =
  | 'externalId'
  | 'inmateCode'
  | 'fullName'
  | 'zone'
  | 'workDivision'
  | 'status'
  | 'releasedAt'
  | 'prisonCode'

/**
 * The DOC export format is not fixed (§13 unknown #1), so the mapper is a
 * synonym table rather than a schema. Anything unrecognised is still carried
 * into `raw_json` — a column nobody mapped is a question for the clerk, not
 * data to throw away.
 */
const SYNONYMS: Record<Field, string[]> = {
  externalId: ['external_id', 'externalid', 'doc_id', 'ref', 'refno', 'รหัสอ้างอิง', 'รหัส doc'],
  inmateCode: [
    'inmate_code',
    'code',
    'prisoner_no',
    'เลขทะเบียน',
    'เลขที่ผู้ต้องขัง',
    'รหัสผู้ต้องขัง',
    'ทะเบียน',
    'เลขประจำตัวผู้ต้องขัง'
  ],
  fullName: [
    'full_name',
    'fullname',
    'name',
    'ชื่อ-สกุล',
    'ชื่อ - สกุล',
    'ชื่อ-นามสกุล',
    'ชื่อสกุล',
    'ชื่อ นามสกุล',
    'ชื่อ'
  ],
  zone: ['zone', 'zone_name', 'แดน', 'ชื่อแดน'],
  workDivision: ['work_division', 'division', 'กองงาน', 'ชื่อกองงาน'],
  status: ['status', 'สถานะ', 'สถานภาพ'],
  releasedAt: ['released_at', 'release_date', 'วันที่ปล่อย', 'วันพ้นโทษ', 'กำหนดปล่อย'],
  prisonCode: ['prison_code', 'prison', 'เรือนจำ', 'รหัสเรือนจำ']
}

const canon = (s: string) => s.toLowerCase().replace(/[\s_.-]+/g, '')

export function mapColumns(headers: string[]) {
  const map: Record<string, Field> = {}
  const taken = new Set<Field>()
  for (const header of headers) {
    const key = canon(header)
    for (const [field, names] of Object.entries(SYNONYMS) as [Field, string[]][]) {
      if (taken.has(field)) continue
      if (names.some((n) => canon(n) === key)) {
        map[header] = field
        taken.add(field)
        break
      }
    }
  }
  return {
    map,
    unmapped: headers.filter((h) => !map[h]),
    has: (f: Field) => taken.has(f)
  }
}

/* ── value normalisation ───────────────────────────────────────────────── */

const STATUS_WORDS: Record<string, InmateStatus> = {
  active: 'active',
  normal: 'active',
  ปกติ: 'active',
  คุมขัง: 'active',
  อยู่: 'active',
  ในเรือนจำ: 'active',
  transferred: 'transferred',
  ย้าย: 'transferred',
  ย้ายเรือนจำ: 'transferred',
  โอนย้าย: 'transferred',
  released: 'released',
  ปล่อย: 'released',
  ปล่อยตัว: 'released',
  พ้นโทษ: 'released',
  deceased: 'deceased',
  เสียชีวิต: 'deceased',
  ถึงแก่กรรม: 'deceased'
}

function parseStatus(value: string): InmateStatus | null {
  if (!value) return 'active'
  return STATUS_WORDS[canon(value)] ?? STATUS_WORDS[value] ?? null
}

/** Thai sheets mix `31/12/2568` (BE) with ISO. Both land on the same epoch. */
function parseDate(value: string): number | null | 'invalid' {
  if (!value) return null
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  const dmy = /^(\d{1,2})[/](\d{1,2})[/](\d{4})$/.exec(value)
  let y: number, m: number, d: number
  if (iso) {
    ;[y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
  } else if (dmy) {
    ;[d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])]
  } else {
    return 'invalid'
  }
  if (y > 2400) y -= 543
  const at = Date.UTC(y, m - 1, d)
  return Number.isFinite(at) ? at : 'invalid'
}

export interface MappedRow {
  externalId: string
  inmateCode: string
  fullName: string
  zone: string
  workDivision: string
  status: string
  releasedAt: string
  prisonCode: string
}

function mapRow(cells: Record<string, string>, map: Record<string, Field>): MappedRow {
  const out: MappedRow = {
    externalId: '',
    inmateCode: '',
    fullName: '',
    zone: '',
    workDivision: '',
    status: '',
    releasedAt: '',
    prisonCode: ''
  }
  for (const [header, field] of Object.entries(map)) out[field] = cells[header] ?? ''
  return out
}

/**
 * The fingerprint of an incoming row. An unchanged row is skipped without ever
 * touching `inmates`, which is what makes re-importing the same export twice
 * produce a diff of zero (the Phase 0b acceptance test).
 */
export function syncHashOf(row: MappedRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        row.externalId,
        row.inmateCode,
        row.fullName,
        row.zone,
        row.workDivision,
        row.status,
        row.releasedAt
      ])
    )
    .digest('hex')
    .slice(0, 32)
}

/* ── planning ──────────────────────────────────────────────────────────── */

interface PlanAction {
  kind: 'create' | 'update' | 'none'
  inmateId?: string
  values?: {
    inmateCode: string
    fullName?: string
    zoneName: string
    divisionName: string
    status: InmateStatus
    releasedAt: number | null
    externalId: string | null
    syncHash: string
    /** Set when the matched inmate is currently held elsewhere. */
    movedFrom?: string
  }
}

export interface PlannedRow {
  rowNo: number
  raw: Record<string, string>
  mapped: MappedRow
  result: ImportRowResult
  message: string | null
  inmateId: string | null
  action: PlanAction
}

export interface ImportPlan {
  rows: PlannedRow[]
  columnMap: Record<string, Field>
  unmapped: string[]
  missing: { inmateId: string; inmateCode: string; fullName: string; zoneName: string | null }[]
  counts: Record<ImportRowResult, number>
}

const changed = (a: unknown, b: unknown) => a !== b

export function planImport(
  table: ParsedTable,
  prisonId: string,
  options: ImportOptions,
  database: Db = defaultDb()
): ImportPlan {
  const columns = mapColumns(table.headers)
  if (!columns.has('fullName')) {
    throw badRequest('ไฟล์นี้ไม่มีคอลัมน์ชื่อ-สกุล จึงนำเข้าไม่ได้')
  }
  if (!columns.has('inmateCode') && !columns.has('externalId')) {
    throw badRequest('ไฟล์นี้ต้องมีคอลัมน์เลขทะเบียนหรือรหัสอ้างอิงอย่างน้อยหนึ่งอย่าง')
  }

  const prison = database.select().from(prisons).where(eq(prisons.id, prisonId)).get()
  if (!prison) throw notFound('ไม่พบเรือนจำ')

  const rows: PlannedRow[] = []
  const counts: Record<ImportRowResult, number> = {
    created: 0,
    updated: 0,
    skipped: 0,
    conflict: 0,
    error: 0
  }
  // Within-file duplicates are a conflict, not a last-one-wins overwrite.
  const seenExternal = new Set<string>()
  const seenCode = new Set<string>()
  const matchedIds = new Set<string>()

  for (const { rowNo, cells } of table.rows) {
    const mapped = mapRow(cells, columns.map)
    const push = (result: ImportRowResult, message: string | null, extra: Partial<PlannedRow> = {}) => {
      counts[result]++
      rows.push({
        rowNo,
        raw: cells,
        mapped,
        result,
        message,
        inmateId: extra.inmateId ?? null,
        action: extra.action ?? { kind: 'none' }
      })
    }

    if (!mapped.fullName) {
      push('error', 'ไม่มีชื่อ-สกุล')
      continue
    }
    if (!mapped.externalId && !mapped.inmateCode) {
      push('error', 'ไม่มีทั้งเลขทะเบียนและรหัสอ้างอิง')
      continue
    }
    if (mapped.prisonCode && canon(mapped.prisonCode) !== canon(prison.code)) {
      const named = database
        .select({ id: prisons.id, nameTh: prisons.nameTh })
        .from(prisons)
        .where(eq(prisons.code, mapped.prisonCode))
        .get()
      push(
        'conflict',
        named
          ? `แถวนี้เป็นข้อมูลของ${named.nameTh} — ให้นำเข้าจากเรือนจำนั้นแทน`
          : `รหัสเรือนจำ "${mapped.prisonCode}" ไม่ตรงกับ ${prison.code}`
      )
      continue
    }

    const status = parseStatus(mapped.status)
    if (!status) {
      push('error', `สถานะ "${mapped.status}" ไม่รู้จัก`)
      continue
    }
    const released = parseDate(mapped.releasedAt)
    if (released === 'invalid') {
      push('error', `วันที่ "${mapped.releasedAt}" อ่านไม่ออก`)
      continue
    }

    if (mapped.externalId && seenExternal.has(mapped.externalId)) {
      push('conflict', 'รหัสอ้างอิงซ้ำกับแถวก่อนหน้าในไฟล์เดียวกัน')
      continue
    }
    if (mapped.inmateCode && seenCode.has(mapped.inmateCode)) {
      push('conflict', 'เลขทะเบียนซ้ำกับแถวก่อนหน้าในไฟล์เดียวกัน')
      continue
    }
    if (mapped.externalId) seenExternal.add(mapped.externalId)
    if (mapped.inmateCode) seenCode.add(mapped.inmateCode)

    if (mapped.zone && !findZoneId(prisonId, mapped.zone, database) && !options.createZones) {
      push('conflict', `ไม่พบแดน "${mapped.zone}" ในเรือนจำนี้`)
      continue
    }

    const existing = mapped.externalId
      ? (findByExternalId(options.source, mapped.externalId, database) ??
        (mapped.inmateCode ? findByCode(prisonId, mapped.inmateCode, database) : undefined))
      : findByCode(prisonId, mapped.inmateCode, database)

    const values = {
      inmateCode: mapped.inmateCode || existing?.inmateCode || '',
      fullName: mapped.fullName,
      zoneName: mapped.zone,
      divisionName: mapped.workDivision,
      status,
      releasedAt: released,
      externalId: mapped.externalId || null,
      syncHash: syncHashOf(mapped)
    }

    if (!existing) {
      if (!values.inmateCode) {
        push('error', 'ผู้ต้องขังรายใหม่ต้องมีเลขทะเบียน')
        continue
      }
      push('created', 'เพิ่มผู้ต้องขังใหม่', { action: { kind: 'create', values } })
      continue
    }

    matchedIds.add(existing.id)

    // The code in the file already belongs to somebody else at this facility.
    if (values.inmateCode !== existing.inmateCode) {
      const clash = findByCode(prisonId, values.inmateCode, database)
      if (clash && clash.id !== existing.id) {
        push('conflict', `เลขทะเบียน ${values.inmateCode} ถูกใช้กับผู้ต้องขังรายอื่นแล้ว`, {
          inmateId: existing.id
        })
        continue
      }
    }
    if (
      mapped.externalId &&
      existing.externalId &&
      existing.externalId !== mapped.externalId &&
      existing.externalSource === options.source
    ) {
      push('conflict', 'เลขทะเบียนนี้ผูกกับรหัสอ้างอิงอื่นอยู่แล้ว', { inmateId: existing.id })
      continue
    }

    const moved = existing.prisonId !== prisonId
    if (existing.syncHash === values.syncHash && !moved && !existing.deletedAt) {
      push('skipped', null, { inmateId: existing.id })
      continue
    }

    const notes: string[] = []
    if (moved) {
      const from = database
        .select({ nameTh: prisons.nameTh })
        .from(prisons)
        .where(eq(prisons.id, existing.prisonId))
        .get()
      notes.push(`ย้ายมาจาก${from?.nameTh ?? 'เรือนจำอื่น'}`)
    }
    if (existing.deletedAt) notes.push('กู้คืนรายการที่ถูกลบ')
    if (changed(existing.fullName, values.fullName)) {
      notes.push(
        existing.isLocallyEdited
          ? `คงชื่อที่เจ้าหน้าที่แก้ไว้ (${existing.fullName})`
          : `ชื่อ: ${existing.fullName} → ${values.fullName}`
      )
    }
    if (mapped.zone) {
      const currentZone = existing.zoneId
        ? (database.select({ name: zones.name }).from(zones).where(eq(zones.id, existing.zoneId)).get()
            ?.name ?? null)
        : null
      if (changed(currentZone, mapped.zone)) notes.push(`แดน: ${currentZone ?? '—'} → ${mapped.zone}`)
    }
    if (changed(existing.status, values.status)) {
      notes.push(`สถานะ: ${existing.status} → ${values.status}`)
    }
    if (changed(existing.inmateCode, values.inmateCode)) {
      notes.push(`เลขทะเบียน: ${existing.inmateCode} → ${values.inmateCode}`)
    }

    push('updated', notes.join(' • ') || 'ปรับข้อมูลให้ตรงกับไฟล์', {
      inmateId: existing.id,
      action: {
        kind: 'update',
        inmateId: existing.id,
        values: {
          ...values,
          // A staff correction outranks the file (§4.1 `is_locally_edited`).
          fullName: existing.isLocallyEdited ? existing.fullName : values.fullName,
          movedFrom: moved ? existing.prisonId : undefined
        }
      }
    })
  }

  // Held here, absent from the file. Never deleted implicitly — a truncated
  // export is the likeliest cause, not a mass release.
  const missing = database
    .select({
      inmateId: inmates.id,
      inmateCode: inmates.inmateCode,
      fullName: inmates.fullName,
      zoneName: zones.name
    })
    .from(inmates)
    .leftJoin(zones, eq(inmates.zoneId, zones.id))
    .where(
      and(
        eq(inmates.prisonId, prisonId),
        eq(inmates.status, 'active'),
        isNull(inmates.deletedAt),
        eq(inmates.externalSource, options.source),
        matchedIds.size > 0 ? notInArray(inmates.id, [...matchedIds]) : undefined
      )
    )
    .orderBy(asc(inmates.inmateCode))
    .all()

  return { rows, columnMap: columns.map, unmapped: columns.unmapped, missing, counts }
}

/* ── applying ──────────────────────────────────────────────────────────── */

function applyPlan(
  plan: ImportPlan,
  prisonId: string,
  options: ImportOptions,
  staffId: string,
  database: Db
) {
  const at = now()
  database.transaction(
    (tx) => {
      const zoneId = (name: string): string | null => {
        if (!name) return null
        const found = findZoneId(prisonId, name, tx)
        if (found) return found
        return options.createZones ? createZone(prisonId, name, tx) : null
      }
      const divisionId = (name: string): string | null => {
        if (!name) return null
        const found = findWorkDivisionId(prisonId, name, tx)
        if (found) return found
        return options.createZones ? createWorkDivision(prisonId, name, tx) : null
      }

      for (const row of plan.rows) {
        const a = row.action
        if (a.kind === 'create' && a.values) {
          const created = tx
            .insert(inmates)
            .values({
              prisonId,
              zoneId: zoneId(a.values.zoneName),
              workDivisionId: divisionId(a.values.divisionName),
              inmateCode: a.values.inmateCode,
              fullName: a.values.fullName!,
              status: a.values.status,
              releasedAt: a.values.releasedAt,
              externalId: a.values.externalId,
              externalSource: a.values.externalId ? options.source : null,
              syncedAt: at,
              syncHash: a.values.syncHash,
              createdBy: staffId,
              updatedBy: staffId
            })
            .returning({ id: inmates.id })
            .get()
          row.inmateId = created.id
        } else if (a.kind === 'update' && a.values && a.inmateId) {
          tx.update(inmates)
            .set({
              prisonId,
              zoneId: a.values.zoneName ? zoneId(a.values.zoneName) : undefined,
              workDivisionId: a.values.divisionName
                ? divisionId(a.values.divisionName)
                : undefined,
              inmateCode: a.values.inmateCode,
              fullName: a.values.fullName!,
              status: a.values.status,
              releasedAt: a.values.releasedAt,
              externalId: a.values.externalId ?? undefined,
              externalSource: a.values.externalId ? options.source : undefined,
              // A row that reappears in the export is a live inmate again.
              deletedAt: null,
              syncedAt: at,
              syncHash: a.values.syncHash,
              updatedBy: staffId,
              updatedAt: at
            })
            .where(eq(inmates.id, a.inmateId))
            .run()
        }
      }

      if (options.missingPolicy === 'mark_transferred' && plan.missing.length > 0) {
        tx.update(inmates)
          .set({ status: 'transferred', updatedBy: staffId, updatedAt: at })
          .where(
            inArray(
              inmates.id,
              plan.missing.map((m) => m.inmateId)
            )
          )
          .run()
      }
    },
    { behavior: 'immediate' }
  )
}

/* ── run bookkeeping ───────────────────────────────────────────────────── */

function writeRunRows(runId: string, plan: ImportPlan, database: DbOrTx) {
  database.delete(inmateImportRows).where(eq(inmateImportRows.runId, runId)).run()
  for (const row of plan.rows) {
    database
      .insert(inmateImportRows)
      .values({
        runId,
        rowNo: row.rowNo,
        rawJson: row.raw,
        result: row.result,
        message: row.message,
        inmateId: row.inmateId
      })
      .run()
  }
}

export function runSummary(runId: string, database: Db = defaultDb()): ImportRunSummary {
  const row = database
    .select()
    .from(inmateImportRuns)
    .where(eq(inmateImportRuns.id, runId))
    .get()
  if (!row) throw notFound('ไม่พบรอบการนำเข้า')
  return toRunSummary(row, database)
}

export function toRunSummary(
  row: typeof inmateImportRuns.$inferSelect,
  database: Db = defaultDb()
): ImportRunSummary {
  const prison = database.select().from(prisons).where(eq(prisons.id, row.prisonId)).get()
  const by = row.runBy ? database.select().from(staff).where(eq(staff.id, row.runBy)).get() : null
  return {
    id: row.id,
    prisonId: row.prisonId,
    prisonName: prison?.nameTh ?? '',
    source: row.source,
    fileName: row.fileName,
    status: row.status,
    startedAt: row.startedAt,
    finishedAt: row.finishedAt,
    rowsTotal: row.rowsTotal,
    rowsCreated: row.rowsCreated,
    rowsUpdated: row.rowsUpdated,
    rowsSkipped: row.rowsSkipped,
    rowsErrored: row.rowsErrored,
    hasErrorReport: !!row.errorReportKey,
    runBy: row.runBy,
    runByName: by?.fullName ?? null,
    options: (row.optionsJson as ImportRunSummary['options']) ?? null
  }
}

/** conflict + error together: both are rows a human has to look at. */
const erroredCount = (plan: ImportPlan) => plan.counts.conflict + plan.counts.error

async function saveErrorReport(
  runId: string,
  table: ParsedTable,
  plan: ImportPlan,
  database: Db
): Promise<string | null> {
  const bad = plan.rows.filter((r) => r.result === 'conflict' || r.result === 'error')
  if (bad.length === 0) return null

  const wb = new ExcelJS.Workbook()
  const sheet = wb.addWorksheet('แถวที่ต้องแก้ไข')
  sheet.columns = [
    { header: 'แถวที่', key: 'rowNo', width: 8 },
    { header: 'ผลลัพธ์', key: 'result', width: 12 },
    { header: 'สาเหตุ', key: 'message', width: 48 },
    ...table.headers.map((h) => ({ header: h, key: `c_${h}`, width: 20 }))
  ]
  sheet.getRow(1).font = { bold: true }
  for (const row of bad) {
    sheet.addRow({
      rowNo: row.rowNo,
      result: row.result === 'conflict' ? 'ข้อมูลขัดแย้ง' : 'ข้อมูลไม่ถูกต้อง',
      message: row.message ?? '',
      ...Object.fromEntries(table.headers.map((h) => [`c_${h}`, row.raw[h] ?? '']))
    })
  }

  const buffer = Buffer.from(await wb.xlsx.writeBuffer())
  const stored = await storage().put(buffer, {
    prefix: 'imports/errors',
    filename: 'errors.xlsx',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  })
  database
    .update(inmateImportRuns)
    .set({ errorReportKey: stored.key })
    .where(eq(inmateImportRuns.id, runId))
    .run()
  return stored.key
}

function toPreview(
  runId: string,
  plan: ImportPlan,
  sampleLimit: number,
  database: Db
): ImportPreview {
  // Conflicts and errors first: the diff is read to find what went wrong.
  const order: Record<ImportRowResult, number> = {
    conflict: 0,
    error: 1,
    created: 2,
    updated: 3,
    skipped: 4
  }
  const sorted = [...plan.rows].sort(
    (a, b) => order[a.result] - order[b.result] || a.rowNo - b.rowNo
  )
  return {
    run: runSummary(runId, database),
    columnMap: plan.columnMap,
    unmappedHeaders: plan.unmapped,
    rows: sorted.slice(0, sampleLimit).map((r) => ({
      rowNo: r.rowNo,
      result: r.result,
      message: r.message,
      inmateId: r.inmateId,
      inmateCode: r.mapped.inmateCode || null,
      fullName: r.mapped.fullName || null,
      raw: r.raw
    })),
    missing: plan.missing.map((m) => ({
      inmateId: m.inmateId,
      inmateCode: m.inmateCode,
      fullName: m.fullName,
      zoneName: m.zoneName
    })),
    missingTotal: plan.missing.length
  }
}

export interface ImportFile {
  buffer: Buffer
  filename?: string
}

/**
 * Step one, always. Nothing is written to `inmates` — the run row and its
 * per-row diff are the whole output, and the uploaded file is kept so `apply`
 * works from exactly the bytes that were previewed.
 */
export async function dryRunImport(
  staffId: string,
  prisonId: string,
  file: ImportFile,
  options: ImportOptions,
  database: Db = defaultDb()
): Promise<ImportPreview> {
  const at = now()
  const table = await parseTable(file.buffer, file.filename)
  const plan = planImport(table, prisonId, options, database)

  const stored = await storage().put(file.buffer, {
    prefix: 'imports/inmates',
    filename: file.filename ?? 'inmates.xlsx'
  })
  const runId = database
    .insert(inmateImportRuns)
    .values({
      prisonId,
      source: options.source,
      fileKey: stored.key,
      fileName: file.filename ?? null,
      fileHash: createHash('sha256').update(file.buffer).digest('hex'),
      optionsJson: options,
      status: 'dry_run',
      startedAt: at,
      finishedAt: now(),
      rowsTotal: plan.rows.length,
      rowsCreated: plan.counts.created,
      rowsUpdated: plan.counts.updated,
      rowsSkipped: plan.counts.skipped,
      rowsErrored: erroredCount(plan),
      runBy: staffId
    })
    .returning({ id: inmateImportRuns.id })
    .get().id

  writeRunRows(runId, plan, database)
  await saveErrorReport(runId, table, plan, database)

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'inmate_import.dry_run',
      entity: 'inmate_import_run',
      entityId: runId,
      prisonId,
      after: { ...plan.counts, missing: plan.missing.length, file: file.filename }
    },
    database
  )

  return toPreview(runId, plan, 200, database)
}

/**
 * Step two. The file is re-read from storage and re-planned against the
 * database as it is *now*, so a preview that has gone stale cannot write a
 * stale decision — the counts in the response are the ones that happened.
 */
export async function applyImport(
  staffId: string,
  runId: string,
  database: Db = defaultDb()
): Promise<ImportPreview> {
  const run = database
    .select()
    .from(inmateImportRuns)
    .where(eq(inmateImportRuns.id, runId))
    .get()
  if (!run) throw notFound('ไม่พบรอบการนำเข้า')
  if (run.status === 'applied') throw conflict('รอบการนำเข้านี้ถูกยืนยันไปแล้ว')
  if (!run.fileKey) throw conflict('ไฟล์ต้นทางของรอบนี้ถูกลบไปแล้ว กรุณาอัปโหลดใหม่')

  const buffer = await storage().get(run.fileKey)
  if (run.fileHash && createHash('sha256').update(buffer).digest('hex') !== run.fileHash) {
    throw conflict('ไฟล์ต้นทางไม่ตรงกับตอนตรวจสอบ กรุณาอัปโหลดใหม่')
  }

  const options = (run.optionsJson ?? { source: run.source }) as ImportOptions
  const table = await parseTable(buffer, run.fileName ?? undefined)
  const plan = planImport(table, run.prisonId, options, database)

  applyPlan(plan, run.prisonId, options, staffId, database)

  const at = now()
  database
    .update(inmateImportRuns)
    .set({
      status: 'applied',
      finishedAt: at,
      rowsTotal: plan.rows.length,
      rowsCreated: plan.counts.created,
      rowsUpdated: plan.counts.updated,
      rowsSkipped: plan.counts.skipped,
      rowsErrored: erroredCount(plan),
      runBy: staffId,
      updatedAt: at
    })
    .where(eq(inmateImportRuns.id, runId))
    .run()

  writeRunRows(runId, plan, database)
  await saveErrorReport(runId, table, plan, database)

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'inmate_import.applied',
      entity: 'inmate_import_run',
      entityId: runId,
      prisonId: run.prisonId,
      after: {
        ...plan.counts,
        missingPolicy: options.missingPolicy,
        missing: plan.missing.length
      }
    },
    database
  )

  return toPreview(runId, plan, 200, database)
}

export function importRuns(
  prisonFilter: SQL | undefined,
  limit: number,
  database: Db = defaultDb()
) {
  return database
    .select()
    .from(inmateImportRuns)
    .where(prisonFilter)
    .orderBy(desc(inmateImportRuns.startedAt))
    .limit(limit)
    .all()
    .map((r) => toRunSummary(r, database))
}

export function importRunRows(
  runId: string,
  result: ImportRowResult | undefined,
  limit: number,
  database: Db = defaultDb()
) {
  return database
    .select()
    .from(inmateImportRows)
    .where(
      and(
        eq(inmateImportRows.runId, runId),
        result ? eq(inmateImportRows.result, result) : undefined
      )
    )
    .orderBy(asc(inmateImportRows.rowNo))
    .limit(limit)
    .all()
    .map((r) => ({
      rowNo: r.rowNo,
      result: r.result,
      message: r.message,
      inmateId: r.inmateId,
      inmateCode: null as string | null,
      fullName: null as string | null,
      raw: (r.rawJson ?? null) as Record<string, unknown> | null
    }))
}

export async function readErrorReport(runId: string, database: Db = defaultDb()) {
  const run = database
    .select()
    .from(inmateImportRuns)
    .where(eq(inmateImportRuns.id, runId))
    .get()
  if (!run) throw notFound('ไม่พบรอบการนำเข้า')
  if (!run.errorReportKey) throw notFound('รอบนี้ไม่มีแถวที่ต้องแก้ไข')
  return { run, buffer: await storage().get(run.errorReportKey) }
}
