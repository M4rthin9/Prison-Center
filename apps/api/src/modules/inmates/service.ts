import { and, eq, isNull, sql, type SQL } from 'drizzle-orm'
import type {
  CreateInmateInput,
  InmateRow,
  TransferInmateInput,
  UpdateInmateInput
} from '@pc/contract'
import { db as defaultDb, type Db, type DbOrTx } from '../../db/client.js'
import {
  customerInmates,
  inmates,
  orders,
  prisons,
  workDivisions,
  zones
} from '../../db/schema/index.js'
import { writeAudit } from '../../lib/audit.js'
import { badRequest, conflict, notFound } from '../../lib/errors.js'
import { now } from '../../lib/time.js'

export interface InmateContext {
  ip?: string | null
  userAgent?: string | null
}

type InmateRecord = typeof inmates.$inferSelect

/* ── views ─────────────────────────────────────────────────────────────── */

const linkCount = sql<number>`(
  select count(*) from ${customerInmates}
  where ${customerInmates.inmateId} = ${inmates.id}
)`.as('link_count')

const rowSelect = {
  id: inmates.id,
  inmateCode: inmates.inmateCode,
  fullName: inmates.fullName,
  prisonId: inmates.prisonId,
  prisonName: prisons.nameTh,
  zoneId: inmates.zoneId,
  zoneName: zones.name,
  workDivisionId: inmates.workDivisionId,
  workDivisionName: workDivisions.name,
  status: inmates.status,
  releasedAt: inmates.releasedAt,
  externalId: inmates.externalId,
  externalSource: inmates.externalSource,
  syncedAt: inmates.syncedAt,
  isLocallyEdited: inmates.isLocallyEdited,
  linkCount,
  deletedAt: inmates.deletedAt,
  createdAt: inmates.createdAt,
  updatedAt: inmates.updatedAt
}

export function inmateQuery(db: Db = defaultDb()) {
  return db
    .select(rowSelect)
    .from(inmates)
    .innerJoin(prisons, eq(inmates.prisonId, prisons.id))
    .leftJoin(zones, eq(inmates.zoneId, zones.id))
    .leftJoin(workDivisions, eq(inmates.workDivisionId, workDivisions.id))
}

export function inmateView(id: string, db: Db = defaultDb()): InmateRow {
  const row = inmateQuery(db).where(eq(inmates.id, id)).get()
  if (!row) throw notFound('ไม่พบผู้ต้องขัง')
  return row
}

/** The raw row, for callers that need `prisonId` before deciding scope. */
export function inmateRecord(id: string, db: Db = defaultDb()): InmateRecord {
  const row = db.select().from(inmates).where(eq(inmates.id, id)).get()
  if (!row) throw notFound('ไม่พบผู้ต้องขัง')
  return row
}

/* ── lookups shared with the importer ──────────────────────────────────── */

/**
 * แดน and กองงาน arrive as free text (§13 unknown #1). Matching is by name
 * first, then code, so `แดน 3` and `Z3` both land on the same row.
 */
export function findZoneId(prisonId: string, name: string, db: DbOrTx = defaultDb()) {
  if (!name) return null
  return (
    db
      .select({ id: zones.id })
      .from(zones)
      .where(and(eq(zones.prisonId, prisonId), eq(zones.name, name)))
      .get()?.id ??
    db
      .select({ id: zones.id })
      .from(zones)
      .where(and(eq(zones.prisonId, prisonId), eq(zones.code, name)))
      .get()?.id ??
    null
  )
}

export function createZone(prisonId: string, name: string, db: DbOrTx = defaultDb()) {
  const sortOrder =
    (db
      .select({ n: sql<number>`coalesce(max(${zones.sortOrder}), -1)` })
      .from(zones)
      .where(eq(zones.prisonId, prisonId))
      .get()?.n ?? -1) + 1
  return db
    .insert(zones)
    .values({ prisonId, name, sortOrder })
    .returning({ id: zones.id })
    .get().id
}

export function findWorkDivisionId(prisonId: string, name: string, db: DbOrTx = defaultDb()) {
  if (!name) return null
  return (
    db
      .select({ id: workDivisions.id })
      .from(workDivisions)
      .where(and(eq(workDivisions.prisonId, prisonId), eq(workDivisions.name, name)))
      .get()?.id ??
    db
      .select({ id: workDivisions.id })
      .from(workDivisions)
      .where(and(eq(workDivisions.prisonId, prisonId), eq(workDivisions.code, name)))
      .get()?.id ??
    null
  )
}

export function createWorkDivision(prisonId: string, name: string, db: DbOrTx = defaultDb()) {
  return db
    .insert(workDivisions)
    .values({ prisonId, name })
    .returning({ id: workDivisions.id })
    .get().id
}

/** `(prison, code)` is unique — the importer needs the clash before it writes. */
export function findByCode(prisonId: string, code: string, db: DbOrTx = defaultDb()) {
  return db
    .select()
    .from(inmates)
    .where(and(eq(inmates.prisonId, prisonId), eq(inmates.inmateCode, code)))
    .get()
}

export function findByExternalId(source: string, externalId: string, db: DbOrTx = defaultDb()) {
  return db
    .select()
    .from(inmates)
    .where(and(eq(inmates.externalSource, source), eq(inmates.externalId, externalId)))
    .get()
}

/* ── CRUD ──────────────────────────────────────────────────────────────── */

function assertZoneBelongs(prisonId: string, zoneId: string | null | undefined, db: Db) {
  if (!zoneId) return
  const zone = db.select().from(zones).where(eq(zones.id, zoneId)).get()
  if (!zone) throw notFound('ไม่พบแดน')
  if (zone.prisonId !== prisonId) throw badRequest('แดนนี้ไม่ได้อยู่ในเรือนจำเดียวกับผู้ต้องขัง')
}

function assertDivisionBelongs(prisonId: string, divisionId: string | null | undefined, db: Db) {
  if (!divisionId) return
  const row = db.select().from(workDivisions).where(eq(workDivisions.id, divisionId)).get()
  if (!row) throw notFound('ไม่พบกองงาน')
  if (row.prisonId !== prisonId) throw badRequest('กองงานนี้ไม่ได้อยู่ในเรือนจำเดียวกัน')
}

export function createInmate(
  staffId: string,
  prisonId: string,
  input: CreateInmateInput,
  ctx: InmateContext = {},
  database: Db = defaultDb()
): InmateRow {
  if (!database.select({ id: prisons.id }).from(prisons).where(eq(prisons.id, prisonId)).get()) {
    throw notFound('ไม่พบเรือนจำ')
  }
  if (findByCode(prisonId, input.inmateCode, database)) {
    throw conflict('เลขทะเบียนนี้มีอยู่ในเรือนจำนี้แล้ว')
  }
  assertZoneBelongs(prisonId, input.zoneId, database)
  assertDivisionBelongs(prisonId, input.workDivisionId, database)

  const source = input.externalSource ?? null
  const externalId = input.externalId ?? null
  if (externalId && source && findByExternalId(source, externalId, database)) {
    throw conflict('รหัสอ้างอิงจากกรมราชทัณฑ์นี้ถูกใช้กับผู้ต้องขังรายอื่นแล้ว')
  }

  const row = database
    .insert(inmates)
    .values({
      prisonId,
      zoneId: input.zoneId ?? null,
      workDivisionId: input.workDivisionId ?? null,
      inmateCode: input.inmateCode,
      fullName: input.fullName,
      status: input.status,
      externalId,
      externalSource: source,
      // Hand-entered from the start: the next import must not rename this row.
      isLocallyEdited: true,
      createdBy: staffId,
      updatedBy: staffId
    })
    .returning()
    .get()

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'inmate.create',
      entity: 'inmate',
      entityId: row.id,
      prisonId,
      after: { inmateCode: row.inmateCode, fullName: row.fullName, zoneId: row.zoneId },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )
  return inmateView(row.id, database)
}

export function updateInmate(
  staffId: string,
  id: string,
  input: UpdateInmateInput,
  ctx: InmateContext = {},
  database: Db = defaultDb()
): InmateRow {
  const before = inmateRecord(id, database)
  if (before.deletedAt) throw conflict('ผู้ต้องขังรายนี้ถูกลบไปแล้ว')

  if (input.inmateCode && input.inmateCode !== before.inmateCode) {
    const clash = findByCode(before.prisonId, input.inmateCode, database)
    if (clash && clash.id !== id) throw conflict('เลขทะเบียนนี้มีอยู่ในเรือนจำนี้แล้ว')
  }
  if (input.zoneId !== undefined) assertZoneBelongs(before.prisonId, input.zoneId, database)
  if (input.workDivisionId !== undefined) {
    assertDivisionBelongs(before.prisonId, input.workDivisionId, database)
  }
  if (input.externalId && before.externalSource) {
    const clash = findByExternalId(before.externalSource, input.externalId, database)
    if (clash && clash.id !== id) throw conflict('รหัสอ้างอิงนี้ถูกใช้กับผู้ต้องขังรายอื่นแล้ว')
  }

  const at = now()
  const status = input.status ?? before.status
  const row = database
    .update(inmates)
    .set({
      ...(input.inmateCode !== undefined ? { inmateCode: input.inmateCode } : {}),
      ...(input.fullName !== undefined ? { fullName: input.fullName } : {}),
      ...(input.zoneId !== undefined ? { zoneId: input.zoneId } : {}),
      ...(input.workDivisionId !== undefined ? { workDivisionId: input.workDivisionId } : {}),
      status,
      releasedAt:
        input.releasedAt !== undefined
          ? input.releasedAt
          : status === 'released' && !before.releasedAt
            ? at
            : before.releasedAt,
      ...(input.externalId !== undefined ? { externalId: input.externalId } : {}),
      // The flag is the contract with the importer: a corrected name survives
      // the next DOC file (§4.1, `is_locally_edited`).
      isLocallyEdited: true,
      updatedBy: staffId,
      updatedAt: at
    })
    .where(eq(inmates.id, id))
    .returning()
    .get()

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'inmate.update',
      entity: 'inmate',
      entityId: id,
      prisonId: before.prisonId,
      before,
      after: row,
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )
  return inmateView(id, database)
}

/**
 * A move between facilities. Orders, letters and deposits keep the zone they
 * were created against, so nothing historical shifts — only the live row does.
 */
export function transferInmate(
  staffId: string,
  id: string,
  input: TransferInmateInput,
  ctx: InmateContext = {},
  database: Db = defaultDb()
): InmateRow {
  const before = inmateRecord(id, database)
  if (before.deletedAt) throw conflict('ผู้ต้องขังรายนี้ถูกลบไปแล้ว')
  if (before.prisonId === input.toPrisonId && (input.toZoneId ?? null) === before.zoneId) {
    throw conflict('ผู้ต้องขังอยู่ที่เรือนจำและแดนนี้อยู่แล้ว')
  }
  if (
    !database
      .select({ id: prisons.id })
      .from(prisons)
      .where(eq(prisons.id, input.toPrisonId))
      .get()
  ) {
    throw notFound('ไม่พบเรือนจำปลายทาง')
  }
  assertZoneBelongs(input.toPrisonId, input.toZoneId, database)
  assertDivisionBelongs(input.toPrisonId, input.toWorkDivisionId, database)

  // The old code may already be taken at the destination — two facilities
  // number independently. Refuse rather than silently renumber a person.
  const clash = findByCode(input.toPrisonId, before.inmateCode, database)
  if (clash && clash.id !== id) {
    throw conflict('เรือนจำปลายทางมีเลขทะเบียนนี้อยู่แล้ว กรุณาแก้เลขทะเบียนก่อนย้าย')
  }

  const at = now()
  database
    .update(inmates)
    .set({
      prisonId: input.toPrisonId,
      zoneId: input.toZoneId ?? null,
      workDivisionId: input.toWorkDivisionId ?? null,
      status: 'active',
      updatedBy: staffId,
      updatedAt: at
    })
    .where(eq(inmates.id, id))
    .run()

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'inmate.transfer',
      entity: 'inmate',
      entityId: id,
      prisonId: input.toPrisonId,
      before: { prisonId: before.prisonId, zoneId: before.zoneId, status: before.status },
      after: { prisonId: input.toPrisonId, zoneId: input.toZoneId ?? null, reason: input.reason },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )
  return inmateView(id, database)
}

/** Live money in flight. Deleting the inmate under it would orphan the order. */
const OPEN_PAYMENT_STATES = ['unpaid', 'awaiting_verify'] as const

export function deleteInmate(
  staffId: string,
  id: string,
  ctx: InmateContext = {},
  database: Db = defaultDb()
): InmateRow {
  const before = inmateRecord(id, database)
  if (before.deletedAt) return inmateView(id, database)

  const open = database
    .select({ n: sql<number>`count(*)` })
    .from(orders)
    .where(
      and(
        eq(orders.inmateId, id),
        sql`${orders.paymentStatus} in (${sql.join(
          OPEN_PAYMENT_STATES.map((s) => sql`${s}`),
          sql`, `
        )})`
      )
    )
    .get()?.n
  if (open && open > 0) throw conflict('ยังมีคำสั่งซื้อที่ค้างชำระของผู้ต้องขังรายนี้')

  const at = now()
  // Soft delete only (§4.1): the ledger must keep pointing at a real row.
  database
    .update(inmates)
    .set({ deletedAt: at, status: 'released', updatedBy: staffId, updatedAt: at })
    .where(eq(inmates.id, id))
    .run()

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'inmate.delete',
      entity: 'inmate',
      entityId: id,
      prisonId: before.prisonId,
      before: { deletedAt: null, status: before.status },
      after: { deletedAt: at },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )
  return inmateView(id, database)
}

export function restoreInmate(
  staffId: string,
  id: string,
  database: Db = defaultDb()
): InmateRow {
  const before = inmateRecord(id, database)
  if (!before.deletedAt) return inmateView(id, database)
  database
    .update(inmates)
    .set({ deletedAt: null, status: 'active', updatedBy: staffId, updatedAt: now() })
    .where(eq(inmates.id, id))
    .run()
  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'inmate.restore',
      entity: 'inmate',
      entityId: id,
      prisonId: before.prisonId,
      after: { deletedAt: null }
    },
    database
  )
  return inmateView(id, database)
}

/** Default list filter — deleted rows are hidden unless explicitly asked for. */
export const notDeleted: SQL | undefined = isNull(inmates.deletedAt)
