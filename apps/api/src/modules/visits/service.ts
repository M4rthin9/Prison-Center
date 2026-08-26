import { and, asc, count, desc, eq, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm'
import type {
  CloseVisitDatesInput,
  CreateVisitBookingInput,
  CreateVisitRoundInput,
  CreateVisitScheduleDayInput,
  GenerateVisitScheduleResult,
  UpdateVisitBookingStatusInput,
  UpdateVisitRoundInput,
  UpdateVisitScheduleDayInput,
  UpsertVisitTemplateInput,
  VisitAvailability,
  VisitBookingDetail,
  VisitBookingStatus,
  VisitRound,
  VisitScheduleDay,
  VisitScheduleGrid,
  VisitSlot,
  VisitSummaryTotals,
  VisitTemplateCell
} from '@pc/contract'
import { db as defaultDb, type Db } from '../../db/client.js'
import {
  customerInmates,
  customers,
  inmates,
  prisons,
  visitBookings,
  visitRounds,
  visitScheduleDays,
  visitScheduleTemplates,
  zones
} from '../../db/schema/index.js'
import { writeAudit } from '../../lib/audit.js'
import { nextVisitBookingNo } from '../../lib/counters.js'
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js'
import { notify } from '../../lib/notify/index.js'
import { addDays, bangkokDate, bangkokEpoch, dateRange, HOUR, now, weekdayOf } from '../../lib/time.js'
import { getSetting } from '../settings/service.js'

export interface VisitContext {
  ip?: string | null
  userAgent?: string | null
}

const THAI_WEEKDAY = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์']
export const thaiWeekday = (weekday: number) => THAI_WEEKDAY[weekday] ?? String(weekday)

/* ── rounds ────────────────────────────────────────────────────────────── */

export function listRounds(
  prisonId: string | null,
  opts: { includeInactive?: boolean } = {},
  database: Db = defaultDb()
): VisitRound[] {
  return database
    .select()
    .from(visitRounds)
    .where(
      and(
        prisonId ? eq(visitRounds.prisonId, prisonId) : undefined,
        opts.includeInactive ? undefined : eq(visitRounds.isActive, true)
      )
    )
    .orderBy(asc(visitRounds.sortOrder), asc(visitRounds.roundNo))
    .all()
    .map(toRound)
}

function toRound(r: typeof visitRounds.$inferSelect): VisitRound {
  return {
    id: r.id,
    prisonId: r.prisonId,
    roundNo: r.roundNo,
    label: r.label,
    session: r.session,
    startTime: r.startTime,
    endTime: r.endTime,
    sortOrder: r.sortOrder,
    isActive: r.isActive
  }
}

export function roundView(id: string, database: Db = defaultDb()): VisitRound {
  const row = database.select().from(visitRounds).where(eq(visitRounds.id, id)).get()
  if (!row) throw notFound('ไม่พบรอบเยี่ยม')
  return toRound(row)
}

function assertTimeOrder(startTime: string, endTime: string) {
  if (endTime <= startTime) throw badRequest('เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่ม')
}

export function createRound(
  prisonId: string,
  input: CreateVisitRoundInput,
  staffId: string,
  ctx: VisitContext = {},
  database: Db = defaultDb()
): VisitRound {
  assertTimeOrder(input.startTime, input.endTime)
  const clash = database
    .select({ id: visitRounds.id })
    .from(visitRounds)
    .where(and(eq(visitRounds.prisonId, prisonId), eq(visitRounds.roundNo, input.roundNo)))
    .get()
  if (clash) throw conflict(`มีรอบที่ ${input.roundNo} ของเรือนจำนี้อยู่แล้ว`)

  const row = database
    .insert(visitRounds)
    .values({
      prisonId,
      roundNo: input.roundNo,
      label: input.label,
      session: input.session,
      startTime: input.startTime,
      endTime: input.endTime,
      sortOrder: input.sortOrder ?? input.roundNo
    })
    .returning()
    .get()

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'visit_round.created',
      entity: 'visit_round',
      entityId: row.id,
      prisonId,
      after: input,
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )
  return toRound(row)
}

export function updateRound(
  roundId: string,
  input: UpdateVisitRoundInput,
  staffId: string,
  ctx: VisitContext = {},
  database: Db = defaultDb()
): VisitRound {
  const before = database.select().from(visitRounds).where(eq(visitRounds.id, roundId)).get()
  if (!before) throw notFound('ไม่พบรอบเยี่ยม')

  const startTime = input.startTime ?? before.startTime
  const endTime = input.endTime ?? before.endTime
  assertTimeOrder(startTime, endTime)

  if (input.roundNo !== undefined && input.roundNo !== before.roundNo) {
    const clash = database
      .select({ id: visitRounds.id })
      .from(visitRounds)
      .where(
        and(
          eq(visitRounds.prisonId, before.prisonId),
          eq(visitRounds.roundNo, input.roundNo),
          ne(visitRounds.id, roundId)
        )
      )
      .get()
    if (clash) throw conflict(`มีรอบที่ ${input.roundNo} ของเรือนจำนี้อยู่แล้ว`)
  }

  database
    .update(visitRounds)
    .set({
      roundNo: input.roundNo ?? before.roundNo,
      label: input.label ?? before.label,
      session: input.session ?? before.session,
      startTime,
      endTime,
      sortOrder: input.sortOrder ?? before.sortOrder,
      isActive: input.isActive ?? before.isActive,
      updatedAt: now()
    })
    .where(eq(visitRounds.id, roundId))
    .run()

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'visit_round.updated',
      entity: 'visit_round',
      entityId: roundId,
      prisonId: before.prisonId,
      before: toRound(before),
      after: input,
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )
  return roundView(roundId, database)
}

/**
 * Deactivation, not deletion, the moment a round has ever been scheduled: the
 * calendar and every booking made against it point at this row.
 */
export function deleteRound(roundId: string, staffId: string, database: Db = defaultDb()): void {
  const before = database.select().from(visitRounds).where(eq(visitRounds.id, roundId)).get()
  if (!before) throw notFound('ไม่พบรอบเยี่ยม')

  const used =
    database
      .select({ n: count() })
      .from(visitScheduleDays)
      .where(eq(visitScheduleDays.roundId, roundId))
      .get()?.n ?? 0
  if (used > 0) {
    throw conflict('รอบนี้ถูกใช้ในตารางเยี่ยมแล้ว ปิดใช้งานแทนการลบ')
  }

  database.delete(visitScheduleTemplates).where(eq(visitScheduleTemplates.roundId, roundId)).run()
  database.delete(visitRounds).where(eq(visitRounds.id, roundId)).run()
  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'visit_round.deleted',
      entity: 'visit_round',
      entityId: roundId,
      prisonId: before.prisonId,
      before: toRound(before)
    },
    database
  )
}

/* ── weekly template ───────────────────────────────────────────────────── */

const templateSelect = {
  id: visitScheduleTemplates.id,
  prisonId: visitScheduleTemplates.prisonId,
  weekday: visitScheduleTemplates.weekday,
  roundId: visitScheduleTemplates.roundId,
  roundLabel: visitRounds.label,
  session: visitRounds.session,
  startTime: visitRounds.startTime,
  endTime: visitRounds.endTime,
  zoneId: visitScheduleTemplates.zoneId,
  zoneName: zones.name,
  capacity: visitScheduleTemplates.capacity,
  isActive: visitScheduleTemplates.isActive
}

export function listTemplates(
  prisonId: string | null,
  database: Db = defaultDb()
): VisitTemplateCell[] {
  return database
    .select(templateSelect)
    .from(visitScheduleTemplates)
    .innerJoin(visitRounds, eq(visitScheduleTemplates.roundId, visitRounds.id))
    .innerJoin(zones, eq(visitScheduleTemplates.zoneId, zones.id))
    .where(prisonId ? eq(visitScheduleTemplates.prisonId, prisonId) : undefined)
    .orderBy(asc(visitScheduleTemplates.weekday), asc(visitRounds.sortOrder), asc(zones.sortOrder))
    .all()
}

/** Upsert on the natural key, so re-saving a grid cell edits it rather than duplicating. */
export function upsertTemplate(
  prisonId: string,
  input: UpsertVisitTemplateInput,
  staffId: string,
  ctx: VisitContext = {},
  database: Db = defaultDb()
): VisitTemplateCell {
  assertBelongsToPrison(prisonId, input.roundId, input.zoneId, database)

  const row = database
    .insert(visitScheduleTemplates)
    .values({
      prisonId,
      weekday: input.weekday,
      roundId: input.roundId,
      zoneId: input.zoneId,
      capacity: input.capacity,
      isActive: input.isActive ?? true
    })
    .onConflictDoUpdate({
      target: [
        visitScheduleTemplates.prisonId,
        visitScheduleTemplates.weekday,
        visitScheduleTemplates.roundId,
        visitScheduleTemplates.zoneId
      ],
      set: { capacity: input.capacity, isActive: input.isActive ?? true, updatedAt: now() }
    })
    .returning({ id: visitScheduleTemplates.id })
    .get()

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'visit_template.upserted',
      entity: 'visit_template',
      entityId: row.id,
      prisonId,
      after: input,
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )

  const view = database
    .select(templateSelect)
    .from(visitScheduleTemplates)
    .innerJoin(visitRounds, eq(visitScheduleTemplates.roundId, visitRounds.id))
    .innerJoin(zones, eq(visitScheduleTemplates.zoneId, zones.id))
    .where(eq(visitScheduleTemplates.id, row.id))
    .get()
  if (!view) throw notFound('ไม่พบแม่แบบตารางเยี่ยม')
  return view
}

/** Scope check needs the owning prison *before* the row is gone. */
export function templatePrisonId(templateId: string, database: Db = defaultDb()): string {
  const row = database
    .select({ prisonId: visitScheduleTemplates.prisonId })
    .from(visitScheduleTemplates)
    .where(eq(visitScheduleTemplates.id, templateId))
    .get()
  if (!row) throw notFound('ไม่พบแม่แบบตารางเยี่ยม')
  return row.prisonId
}

export function deleteTemplate(
  templateId: string,
  staffId: string,
  database: Db = defaultDb()
): { prisonId: string } {
  const before = database
    .select()
    .from(visitScheduleTemplates)
    .where(eq(visitScheduleTemplates.id, templateId))
    .get()
  if (!before) throw notFound('ไม่พบแม่แบบตารางเยี่ยม')

  database.delete(visitScheduleTemplates).where(eq(visitScheduleTemplates.id, templateId)).run()
  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'visit_template.deleted',
      entity: 'visit_template',
      entityId: templateId,
      prisonId: before.prisonId,
      before
    },
    database
  )
  return { prisonId: before.prisonId }
}

function assertBelongsToPrison(
  prisonId: string,
  roundId: string,
  zoneId: string,
  database: Db
): void {
  const round = database.select().from(visitRounds).where(eq(visitRounds.id, roundId)).get()
  if (!round) throw notFound('ไม่พบรอบเยี่ยม')
  if (round.prisonId !== prisonId) throw badRequest('รอบเยี่ยมไม่ได้อยู่ในเรือนจำนี้')
  const zone = database.select().from(zones).where(eq(zones.id, zoneId)).get()
  if (!zone) throw notFound('ไม่พบแดน')
  if (zone.prisonId !== prisonId) throw badRequest('แดนไม่ได้อยู่ในเรือนจำนี้')
}

/* ── materialize (template → calendar) ─────────────────────────────────── */

/**
 * Idempotent by construction: the insert conflicts on
 * `(prison, date, round, zone)` and does nothing, so a row a staff member has
 * edited — closed, re-zoned, re-capacitied — survives every re-run. Manual
 * edits win, permanently (§4.6).
 */
export function materializeSchedule(
  prisonId: string,
  opts: { weeks?: number; from?: string; at?: number } = {},
  database: Db = defaultDb()
): GenerateVisitScheduleResult {
  const at = opts.at ?? now()
  const weeks = opts.weeks ?? getSetting('visit.horizon_weeks', { prisonId, db: database })
  const from = opts.from ?? bangkokDate(at)
  const to = addDays(from, weeks * 7 - 1)

  const templates = database
    .select()
    .from(visitScheduleTemplates)
    .where(
      and(
        eq(visitScheduleTemplates.prisonId, prisonId),
        eq(visitScheduleTemplates.isActive, true)
      )
    )
    .all()
  if (templates.length === 0) return { from, to, created: 0, skipped: 0 }

  const byWeekday = new Map<number, typeof templates>()
  for (const t of templates) {
    const list = byWeekday.get(t.weekday) ?? []
    list.push(t)
    byWeekday.set(t.weekday, list)
  }

  let created = 0
  let skipped = 0
  database.transaction(
    (tx) => {
      for (const date of dateRange(from, to)) {
        for (const t of byWeekday.get(weekdayOf(date)) ?? []) {
          const res = tx
            .insert(visitScheduleDays)
            .values({
              prisonId,
              date,
              roundId: t.roundId,
              zoneId: t.zoneId,
              capacity: t.capacity,
              source: 'template'
            })
            .onConflictDoNothing({
              target: [
                visitScheduleDays.prisonId,
                visitScheduleDays.date,
                visitScheduleDays.roundId,
                visitScheduleDays.zoneId
              ]
            })
            .run()
          if (res.changes > 0) created++
          else skipped++
        }
      }
    },
    { behavior: 'immediate' }
  )

  return { from, to, created, skipped }
}

/** The job's entry point: every active facility, one horizon each. */
export function materializeAll(database: Db = defaultDb()) {
  const rows = database
    .select({ id: prisons.id })
    .from(prisons)
    .where(eq(prisons.isActive, true))
    .all()
  let created = 0
  for (const p of rows) created += materializeSchedule(p.id, {}, database).created
  return { prisons: rows.length, created }
}

/* ── the calendar itself ───────────────────────────────────────────────── */

const daySelect = {
  id: visitScheduleDays.id,
  prisonId: visitScheduleDays.prisonId,
  date: visitScheduleDays.date,
  roundId: visitScheduleDays.roundId,
  roundNo: visitRounds.roundNo,
  roundLabel: visitRounds.label,
  session: visitRounds.session,
  startTime: visitRounds.startTime,
  endTime: visitRounds.endTime,
  zoneId: visitScheduleDays.zoneId,
  zoneName: zones.name,
  capacity: visitScheduleDays.capacity,
  bookedCount: visitScheduleDays.bookedCount,
  isClosed: visitScheduleDays.isClosed,
  note: visitScheduleDays.note,
  source: visitScheduleDays.source
}

export function scheduleDayQuery(database: Db = defaultDb()) {
  return database
    .select(daySelect)
    .from(visitScheduleDays)
    .innerJoin(visitRounds, eq(visitScheduleDays.roundId, visitRounds.id))
    .innerJoin(zones, eq(visitScheduleDays.zoneId, zones.id))
}

export function scheduleDayView(id: string, database: Db = defaultDb()): VisitScheduleDay {
  const row = scheduleDayQuery(database).where(eq(visitScheduleDays.id, id)).get()
  if (!row) throw notFound('ไม่พบช่องเวลาเยี่ยม')
  return row
}

/** The week grid (§4.6): rounds down the left, dates across the top. */
export function scheduleGrid(
  prisonId: string | null,
  from: string,
  to: string,
  database: Db = defaultDb()
): VisitScheduleGrid {
  const cells = scheduleDayQuery(database)
    .where(
      and(
        prisonId ? eq(visitScheduleDays.prisonId, prisonId) : undefined,
        gte(visitScheduleDays.date, from),
        lte(visitScheduleDays.date, to)
      )
    )
    .orderBy(asc(visitScheduleDays.date), asc(visitRounds.sortOrder), asc(zones.sortOrder))
    .all()

  return {
    prisonId,
    from,
    to,
    dates: dateRange(from, to),
    rounds: listRounds(prisonId, { includeInactive: true }, database),
    zones: database
      .select({ id: zones.id, name: zones.name })
      .from(zones)
      .where(
        and(prisonId ? eq(zones.prisonId, prisonId) : undefined, eq(zones.isActive, true))
      )
      .orderBy(asc(zones.sortOrder))
      .all(),
    cells
  }
}

export function createScheduleDay(
  prisonId: string,
  input: CreateVisitScheduleDayInput,
  staffId: string,
  ctx: VisitContext = {},
  database: Db = defaultDb()
): VisitScheduleDay {
  assertBelongsToPrison(prisonId, input.roundId, input.zoneId, database)

  const existing = database
    .select({ id: visitScheduleDays.id })
    .from(visitScheduleDays)
    .where(
      and(
        eq(visitScheduleDays.prisonId, prisonId),
        eq(visitScheduleDays.date, input.date),
        eq(visitScheduleDays.roundId, input.roundId),
        eq(visitScheduleDays.zoneId, input.zoneId)
      )
    )
    .get()
  if (existing) throw conflict('มีช่องเวลานี้อยู่แล้วในตาราง')

  const row = database
    .insert(visitScheduleDays)
    .values({
      prisonId,
      date: input.date,
      roundId: input.roundId,
      zoneId: input.zoneId,
      capacity: input.capacity,
      note: input.note ?? null,
      // Anything a person typed is `manual`, and the job leaves it alone forever.
      source: 'manual',
      createdBy: staffId,
      updatedBy: staffId
    })
    .returning({ id: visitScheduleDays.id })
    .get()

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'visit_schedule.created',
      entity: 'visit_schedule_day',
      entityId: row.id,
      prisonId,
      after: input,
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )
  return scheduleDayView(row.id, database)
}

export function updateScheduleDay(
  dayId: string,
  input: UpdateVisitScheduleDayInput,
  staffId: string,
  ctx: VisitContext = {},
  database: Db = defaultDb()
): VisitScheduleDay {
  const before = database
    .select()
    .from(visitScheduleDays)
    .where(eq(visitScheduleDays.id, dayId))
    .get()
  if (!before) throw notFound('ไม่พบช่องเวลาเยี่ยม')

  if (input.capacity !== undefined && input.capacity < before.bookedCount) {
    throw conflict(`มีการจองแล้ว ${before.bookedCount} รายการ ลดความจุต่ำกว่านี้ไม่ได้`)
  }
  if (input.zoneId && input.zoneId !== before.zoneId) {
    if (before.bookedCount > 0) throw conflict('มีการจองแล้ว เปลี่ยนแดนของช่องนี้ไม่ได้')
    assertBelongsToPrison(before.prisonId, before.roundId, input.zoneId, database)
  }

  database
    .update(visitScheduleDays)
    .set({
      zoneId: input.zoneId ?? before.zoneId,
      capacity: input.capacity ?? before.capacity,
      isClosed: input.isClosed ?? before.isClosed,
      note: input.note === undefined ? before.note : input.note,
      // A staff edit converts a generated row into a manual one — that is the
      // whole mechanism behind "manual edits win, permanently".
      source: 'manual',
      updatedBy: staffId,
      updatedAt: now()
    })
    .where(eq(visitScheduleDays.id, dayId))
    .run()

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'visit_schedule.updated',
      entity: 'visit_schedule_day',
      entityId: dayId,
      prisonId: before.prisonId,
      before: { capacity: before.capacity, isClosed: before.isClosed, zoneId: before.zoneId },
      after: input,
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )
  return scheduleDayView(dayId, database)
}

/** Only an empty cell can vanish. A booked one is closed, so the family still sees why. */
export function deleteScheduleDay(dayId: string, staffId: string, database: Db = defaultDb()) {
  const before = database
    .select()
    .from(visitScheduleDays)
    .where(eq(visitScheduleDays.id, dayId))
    .get()
  if (!before) throw notFound('ไม่พบช่องเวลาเยี่ยม')
  if (before.bookedCount > 0) throw conflict('มีการจองในช่องนี้แล้ว ให้ปิดช่องแทนการลบ')

  database.delete(visitScheduleDays).where(eq(visitScheduleDays.id, dayId)).run()
  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'visit_schedule.deleted',
      entity: 'visit_schedule_day',
      entityId: dayId,
      prisonId: before.prisonId,
      before
    },
    database
  )
  return { prisonId: before.prisonId, date: before.date }
}

/** The holiday / lockdown action: close (or reopen) every cell in a date range. */
export function closeDates(
  prisonId: string,
  input: CloseVisitDatesInput,
  staffId: string,
  ctx: VisitContext = {},
  database: Db = defaultDb()
): { affected: number } {
  if (input.to < input.from) throw badRequest('ช่วงวันที่ไม่ถูกต้อง')

  const res = database
    .update(visitScheduleDays)
    .set({
      isClosed: input.isClosed,
      note: input.note ?? null,
      source: 'manual',
      updatedBy: staffId,
      updatedAt: now()
    })
    .where(
      and(
        eq(visitScheduleDays.prisonId, prisonId),
        gte(visitScheduleDays.date, input.from),
        lte(visitScheduleDays.date, input.to)
      )
    )
    .run()

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: input.isClosed ? 'visit_schedule.closed' : 'visit_schedule.reopened',
      entity: 'visit_schedule_day',
      entityId: null,
      prisonId,
      after: { ...input, affected: res.changes },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )
  return { affected: res.changes }
}

/* ── availability ──────────────────────────────────────────────────────── */

/** Money and visits both need a verified link — an unverified relative is a stranger. */
function assertMayBook(customerId: string, inmateId: string, database: Db) {
  const inmate = database.select().from(inmates).where(eq(inmates.id, inmateId)).get()
  if (!inmate || inmate.deletedAt) throw notFound('ไม่พบผู้ต้องขัง')
  if (inmate.status !== 'active') throw conflict('ผู้ต้องขังรายนี้ไม่ได้อยู่ในเรือนจำแล้ว')

  const link = database
    .select()
    .from(customerInmates)
    .where(and(eq(customerInmates.customerId, customerId), eq(customerInmates.inmateId, inmateId)))
    .get()
  if (!link) throw forbidden('บัญชีของคุณยังไม่ได้ผูกกับผู้ต้องขังรายนี้')
  if (link.verifyStatus !== 'verified') {
    throw forbidden('คำขอผูกบัญชีกับผู้ต้องขังรายนี้ยังไม่ได้รับการยืนยันจากเจ้าหน้าที่')
  }
  return inmate
}

export function availability(
  customerId: string,
  inmateId: string,
  range: { from?: string; to?: string } = {},
  at = now(),
  database: Db = defaultDb()
): VisitAvailability {
  const inmate = assertMayBook(customerId, inmateId, database)
  const scope = { prisonId: inmate.prisonId, db: database }
  const horizon = getSetting('visit.horizon_weeks', scope)
  const cutoffHours = getSetting('visit.booking_cutoff_hours', scope)

  const today = bangkokDate(at)
  const from = range.from && range.from > today ? range.from : today
  const maxTo = addDays(today, horizon * 7 - 1)
  const to = range.to && range.to < maxTo ? range.to : maxTo

  const zone = inmate.zoneId
    ? database.select().from(zones).where(eq(zones.id, inmate.zoneId)).get()
    : null

  // A visit happens in the inmate's แดน, so the calendar is filtered by it.
  // An inmate with no zone on file cannot be booked until staff fix the record.
  const rows = inmate.zoneId
    ? scheduleDayQuery(database)
        .where(
          and(
            eq(visitScheduleDays.prisonId, inmate.prisonId),
            eq(visitScheduleDays.zoneId, inmate.zoneId),
            gte(visitScheduleDays.date, from),
            lte(visitScheduleDays.date, to)
          )
        )
        .orderBy(asc(visitScheduleDays.date), asc(visitRounds.sortOrder))
        .all()
    : []

  const slots: VisitSlot[] = rows.map((r) => {
    const startsAt = bangkokEpoch(r.date, r.startTime)
    const available = Math.max(0, r.capacity - r.bookedCount)
    return {
      scheduleDayId: r.id,
      date: r.date,
      roundId: r.roundId,
      roundNo: r.roundNo,
      roundLabel: r.roundLabel,
      session: r.session,
      startTime: r.startTime,
      endTime: r.endTime,
      startsAt,
      zoneId: r.zoneId,
      zoneName: r.zoneName,
      capacity: r.capacity,
      bookedCount: r.bookedCount,
      available,
      isClosed: r.isClosed,
      isBookable: !r.isClosed && available > 0 && startsAt - cutoffHours * HOUR > at,
      note: r.note
    }
  })

  return {
    inmateId,
    inmateName: inmate.fullName,
    zoneId: inmate.zoneId,
    zoneName: zone?.name ?? null,
    from,
    to,
    cutoffHours,
    slots
  }
}

/* ── bookings ──────────────────────────────────────────────────────────── */

const bookingSelect = {
  id: visitBookings.id,
  bookingNo: visitBookings.bookingNo,
  status: visitBookings.status,
  customerId: visitBookings.customerId,
  customerName: customers.fullName,
  customerPhone: customers.phone,
  inmateId: visitBookings.inmateId,
  inmateCode: visitBookings.inmateCodeSnapshot,
  inmateName: visitBookings.inmateNameSnapshot,
  prisonId: visitBookings.prisonId,
  prisonName: prisons.nameTh,
  zoneName: visitBookings.zoneNameSnapshot,
  visitDate: visitBookings.visitDate,
  roundLabel: visitBookings.roundLabelSnapshot,
  session: visitBookings.session,
  startTime: visitBookings.startTime,
  endTime: visitBookings.endTime,
  startsAt: visitBookings.startsAt,
  visitorName: visitBookings.visitorName,
  contactPhone: visitBookings.contactPhone,
  visitorCount: visitBookings.visitorCount,
  checkedInAt: visitBookings.checkedInAt,
  createdAt: visitBookings.createdAt
}

export function bookingQuery(database: Db = defaultDb()) {
  return database
    .select(bookingSelect)
    .from(visitBookings)
    .innerJoin(customers, eq(visitBookings.customerId, customers.id))
    .innerJoin(prisons, eq(visitBookings.prisonId, prisons.id))
}

export function bookingDetail(
  bookingId: string,
  at = now(),
  database: Db = defaultDb()
): VisitBookingDetail {
  const row = database.select().from(visitBookings).where(eq(visitBookings.id, bookingId)).get()
  if (!row) throw notFound('ไม่พบการจองเยี่ยม')
  const summary = bookingQuery(database).where(eq(visitBookings.id, bookingId)).get()!

  const cutoffHours = getSetting('visit.booking_cutoff_hours', {
    prisonId: row.prisonId,
    db: database
  })
  return {
    ...summary,
    scheduleDayId: row.scheduleDayId,
    roundId: row.roundId,
    lineIdText: row.lineIdText,
    note: row.note,
    cancelledReason: row.cancelledReason,
    cancelledAt: row.cancelledAt,
    canCancel:
      (row.status === 'pending' || row.status === 'confirmed') &&
      row.startsAt - cutoffHours * HOUR > at
  }
}

/** Statuses that still hold a seat in `visit_schedule_days.booked_count`. */
const LIVE_STATES: VisitBookingStatus[] = ['pending', 'confirmed', 'checked_in']

export async function createBooking(
  customerId: string,
  input: CreateVisitBookingInput,
  ctx: VisitContext = {},
  at = now(),
  database: Db = defaultDb()
): Promise<VisitBookingDetail> {
  const inmate = assertMayBook(customerId, input.inmateId, database)
  const scope = { prisonId: inmate.prisonId, db: database }

  const cell = scheduleDayQuery(database).where(eq(visitScheduleDays.id, input.scheduleDayId)).get()
  if (!cell) throw notFound('ไม่พบช่องเวลาเยี่ยม')
  if (cell.prisonId !== inmate.prisonId) throw badRequest('ช่องเวลานี้ไม่ได้อยู่ในเรือนจำเดียวกัน')
  if (cell.zoneId !== inmate.zoneId) throw badRequest('ช่องเวลานี้ไม่ใช่แดนของผู้ต้องขังรายนี้')
  if (cell.isClosed) throw conflict('ช่วงเวลานี้ปิดรับการเยี่ยม')

  const startsAt = bangkokEpoch(cell.date, cell.startTime)
  const cutoffHours = getSetting('visit.booking_cutoff_hours', scope)
  if (startsAt - cutoffHours * HOUR <= at) {
    throw conflict(`ปิดรับจองก่อนเวลาเยี่ยม ${cutoffHours} ชั่วโมง`)
  }

  const maxVisitors = getSetting('visit.max_visitors_per_booking', scope)
  const visitorCount = input.visitorCount ?? 1
  if (visitorCount > maxVisitors) throw badRequest(`ผู้เยี่ยมได้สูงสุด ${maxVisitors} คนต่อการจอง`)

  // One visit per inmate per day (§4.6). Checked here for the readable error;
  // the partial UNIQUE index is what actually makes it true under a race.
  const sameDay = database
    .select({ id: visitBookings.id })
    .from(visitBookings)
    .where(
      and(
        eq(visitBookings.inmateId, inmate.id),
        eq(visitBookings.visitDate, cell.date),
        inArray(visitBookings.status, LIVE_STATES)
      )
    )
    .get()
  if (sameDay) throw conflict('ผู้ต้องขังรายนี้มีการจองเยี่ยมในวันดังกล่าวแล้ว')

  const open =
    database
      .select({ n: count() })
      .from(visitBookings)
      .where(
        and(
          eq(visitBookings.inmateId, inmate.id),
          inArray(visitBookings.status, ['pending', 'confirmed']),
          gte(visitBookings.startsAt, at)
        )
      )
      .get()?.n ?? 0
  if (open >= getSetting('visit.max_open_per_inmate', scope)) {
    throw conflict('มีการจองเยี่ยมที่ยังไม่ถึงวันของผู้ต้องขังรายนี้ครบจำนวนแล้ว')
  }

  const prison = database.select().from(prisons).where(eq(prisons.id, inmate.prisonId)).get()
  if (!prison) throw notFound('ไม่พบเรือนจำ')
  const status: VisitBookingStatus = getSetting('visit.auto_confirm', scope)
    ? 'confirmed'
    : 'pending'

  /**
   * §4.6, verbatim: take the write lock, bump the counter *with the guard in
   * the WHERE clause*, and treat "0 rows changed" as full-or-closed. There is
   * no read-then-write window here, which is the entire point.
   */
  const bookingId = database.transaction(
    (tx) => {
      const bumped = tx
        .update(visitScheduleDays)
        .set({ bookedCount: sql`${visitScheduleDays.bookedCount} + 1`, updatedAt: at })
        .where(
          and(
            eq(visitScheduleDays.id, cell.id),
            eq(visitScheduleDays.isClosed, false),
            sql`${visitScheduleDays.bookedCount} < ${visitScheduleDays.capacity}`
          )
        )
        .run()
      if (bumped.changes === 0) throw conflict('ช่วงเวลานี้เต็มหรือถูกปิดแล้ว')

      const bookingNo = nextVisitBookingNo(prison.id, prison.code, tx, at)
      return tx
        .insert(visitBookings)
        .values({
          bookingNo,
          customerId,
          inmateId: inmate.id,
          prisonId: prison.id,
          zoneId: cell.zoneId,
          scheduleDayId: cell.id,
          visitDate: cell.date,
          roundId: cell.roundId,
          session: cell.session,
          startTime: cell.startTime,
          endTime: cell.endTime,
          startsAt,
          roundLabelSnapshot: cell.roundLabel,
          zoneNameSnapshot: cell.zoneName,
          inmateCodeSnapshot: inmate.inmateCode,
          inmateNameSnapshot: inmate.fullName,
          visitorName: input.visitorName,
          contactPhone: input.contactPhone,
          lineIdText: input.lineIdText ?? null,
          visitorCount,
          note: input.note ?? null,
          status,
          createdAt: at,
          updatedAt: at,
          createdBy: customerId
        })
        .returning({ id: visitBookings.id })
        .get().id
    },
    { behavior: 'immediate' }
  )

  writeAudit(
    {
      actorType: 'customer',
      actorId: customerId,
      action: 'visit.booked',
      entity: 'visit_booking',
      entityId: bookingId,
      prisonId: prison.id,
      after: { inmateId: inmate.id, date: cell.date, roundId: cell.roundId, status },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )

  return bookingDetail(bookingId, at, database)
}

/** Cancellation decrements in the same transaction as the status change (§4.6). */
export async function cancelBooking(
  bookingId: string,
  opts: {
    actor: 'customer' | 'staff'
    actorId: string
    reason?: string
    at?: number
    /** Staff may cancel past the cutoff; a family may not. */
    ignoreCutoff?: boolean
    ctx?: VisitContext
  },
  database: Db = defaultDb()
): Promise<VisitBookingDetail> {
  const at = opts.at ?? now()
  const before = database.select().from(visitBookings).where(eq(visitBookings.id, bookingId)).get()
  if (!before) throw notFound('ไม่พบการจองเยี่ยม')
  if (before.status === 'cancelled') throw conflict('การจองนี้ถูกยกเลิกไปแล้ว')
  if (before.status === 'checked_in') throw conflict('เข้าเยี่ยมไปแล้ว ยกเลิกไม่ได้')

  if (!opts.ignoreCutoff) {
    const cutoffHours = getSetting('visit.booking_cutoff_hours', {
      prisonId: before.prisonId,
      db: database
    })
    if (before.startsAt - cutoffHours * HOUR <= at) {
      throw conflict(`ยกเลิกได้ก่อนเวลาเยี่ยมอย่างน้อย ${cutoffHours} ชั่วโมง`)
    }
  }

  database.transaction(
    (tx) => {
      tx.update(visitBookings)
        .set({
          status: 'cancelled',
          cancelledReason: opts.reason ?? null,
          cancelledAt: at,
          updatedBy: opts.actorId,
          updatedAt: at
        })
        .where(eq(visitBookings.id, bookingId))
        .run()

      // `max(0, …)` is belt-and-braces against a counter that drifted; the
      // CHECK constraint would otherwise take the whole cancellation down.
      tx.update(visitScheduleDays)
        .set({
          bookedCount: sql`max(0, ${visitScheduleDays.bookedCount} - 1)`,
          updatedAt: at
        })
        .where(eq(visitScheduleDays.id, before.scheduleDayId))
        .run()
    },
    { behavior: 'immediate' }
  )

  writeAudit(
    {
      actorType: opts.actor,
      actorId: opts.actorId,
      action: 'visit.cancelled',
      entity: 'visit_booking',
      entityId: bookingId,
      prisonId: before.prisonId,
      before: { status: before.status },
      after: { status: 'cancelled', reason: opts.reason },
      ip: opts.ctx?.ip,
      userAgent: opts.ctx?.userAgent
    },
    database
  )

  if (opts.actor === 'staff') {
    await notify({
      audience: 'customer',
      recipientId: before.customerId,
      kind: 'visit.reminder',
      title: `การจองเยี่ยม ${before.bookingNo} ถูกยกเลิก`,
      body: opts.reason ?? 'กรุณาติดต่อเจ้าหน้าที่เรือนจำ',
      data: { bookingId, bookingNo: before.bookingNo, status: 'cancelled' }
    })
  }

  return bookingDetail(bookingId, at, database)
}

const ALLOWED: Record<VisitBookingStatus, VisitBookingStatus[]> = {
  pending: ['confirmed', 'cancelled', 'no_show'],
  confirmed: ['checked_in', 'cancelled', 'no_show'],
  checked_in: [],
  cancelled: [],
  no_show: []
}

/** The gate desk: confirm, check in, or record a no-show. */
export async function setBookingStatus(
  staffId: string,
  bookingId: string,
  input: UpdateVisitBookingStatusInput,
  ctx: VisitContext = {},
  at = now(),
  database: Db = defaultDb()
): Promise<VisitBookingDetail> {
  const before = database.select().from(visitBookings).where(eq(visitBookings.id, bookingId)).get()
  if (!before) throw notFound('ไม่พบการจองเยี่ยม')

  if (input.status === 'cancelled') {
    return cancelBooking(
      bookingId,
      { actor: 'staff', actorId: staffId, reason: input.reason, at, ignoreCutoff: true, ctx },
      database
    )
  }
  if (!ALLOWED[before.status].includes(input.status)) {
    throw conflict(`เปลี่ยนสถานะจาก "${before.status}" เป็น "${input.status}" ไม่ได้`)
  }

  // A no-show frees nothing: the slot was held and the round has passed. It is
  // an attendance fact, not a cancellation, and the p.12 report needs both.
  database
    .update(visitBookings)
    .set({
      status: input.status,
      checkedInAt: input.status === 'checked_in' ? at : before.checkedInAt,
      cancelledReason: input.reason ?? before.cancelledReason,
      updatedBy: staffId,
      updatedAt: at
    })
    .where(eq(visitBookings.id, bookingId))
    .run()

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: `visit.${input.status}`,
      entity: 'visit_booking',
      entityId: bookingId,
      prisonId: before.prisonId,
      before: { status: before.status },
      after: { status: input.status, reason: input.reason },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )

  if (input.status === 'confirmed') {
    await notify({
      audience: 'customer',
      recipientId: before.customerId,
      kind: 'visit.reminder',
      title: `ยืนยันการจองเยี่ยม ${before.bookingNo} แล้ว`,
      body: `${before.visitDate} ${before.roundLabelSnapshot} ${before.startTime}–${before.endTime}`,
      data: { bookingId, bookingNo: before.bookingNo, status: input.status }
    })
  }

  return bookingDetail(bookingId, at, database)
}

/* ── the reminder job ──────────────────────────────────────────────────── */

/**
 * One notification per booking, ever: `reminded_at` is the idempotency key, so
 * a scheduler that fires twice an hour does not wake a family twice an hour.
 */
export async function sendVisitReminders(
  at = now(),
  database: Db = defaultDb()
): Promise<{ sent: number }> {
  const horizon = at + 48 * HOUR
  const due = database
    .select()
    .from(visitBookings)
    .where(
      and(
        inArray(visitBookings.status, ['pending', 'confirmed']),
        isNull(visitBookings.remindedAt),
        gte(visitBookings.startsAt, at),
        lte(visitBookings.startsAt, horizon)
      )
    )
    .orderBy(asc(visitBookings.startsAt))
    .limit(200)
    .all()

  let sent = 0
  for (const b of due) {
    const hours = getSetting('visit.reminder_hours', { prisonId: b.prisonId, db: database })
    if (b.startsAt - hours * HOUR > at) continue

    await notify({
      audience: 'customer',
      recipientId: b.customerId,
      kind: 'visit.reminder',
      title: `พรุ่งนี้มีนัดเยี่ยม ${b.inmateNameSnapshot}`,
      body:
        `${b.visitDate} ${b.roundLabelSnapshot} ${b.startTime}–${b.endTime}` +
        `${b.zoneNameSnapshot ? ` · ${b.zoneNameSnapshot}` : ''} · เลขที่ ${b.bookingNo}`,
      data: { bookingId: b.id, bookingNo: b.bookingNo, visitDate: b.visitDate }
    })
    database
      .update(visitBookings)
      .set({ remindedAt: at })
      .where(eq(visitBookings.id, b.id))
      .run()
    sent++
  }
  return { sent }
}

/* ── dashboard tile (p.11) / report spine (p.12) ───────────────────────── */

export function visitTotals(
  prisonId: string | null,
  range: { from?: string; to?: string } = {},
  database: Db = defaultDb()
): VisitSummaryTotals {
  const where = and(
    prisonId ? eq(visitBookings.prisonId, prisonId) : undefined,
    range.from ? gte(visitBookings.visitDate, range.from) : undefined,
    range.to ? lte(visitBookings.visitDate, range.to) : undefined
  )

  const rows = database
    .select({ status: visitBookings.status, n: count() })
    .from(visitBookings)
    .where(where)
    .groupBy(visitBookings.status)
    .all()

  const capacityTotal =
    database
      .select({ total: sql<number>`coalesce(sum(${visitScheduleDays.capacity}), 0)` })
      .from(visitScheduleDays)
      .where(
        and(
          prisonId ? eq(visitScheduleDays.prisonId, prisonId) : undefined,
          eq(visitScheduleDays.isClosed, false),
          range.from ? gte(visitScheduleDays.date, range.from) : undefined,
          range.to ? lte(visitScheduleDays.date, range.to) : undefined
        )
      )
      .get()?.total ?? 0

  const by = (s: VisitBookingStatus) => rows.find((r) => r.status === s)?.n ?? 0
  // A booking that was honoured or is still live is a seat that was used; a
  // cancellation gave its seat back and must not inflate utilisation.
  const bookedCount = by('pending') + by('confirmed') + by('checked_in') + by('no_show')

  return {
    from: range.from ?? null,
    to: range.to ?? null,
    buckets: rows.map((r) => ({ status: r.status, count: r.n })),
    bookedCount,
    checkedInCount: by('checked_in'),
    cancelledCount: by('cancelled'),
    noShowCount: by('no_show'),
    capacityTotal,
    utilisation: capacityTotal > 0 ? Math.round((bookedCount / capacityTotal) * 1000) / 1000 : 0
  }
}

export const bookingOrder = [desc(visitBookings.startsAt), desc(visitBookings.id)] as const
