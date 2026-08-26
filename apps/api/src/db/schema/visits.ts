import { relations, sql } from 'drizzle-orm'
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { bool, id, timestamps, ts } from './_shared.js'
import { inmates, prisons, zones } from './facility.js'
import { customers } from './people.js'

/**
 * §4.6 / decision #6. Staff enter the schedule by hand — which รอบ, which แดน,
 * which day — so the p.12 weekday grid is a *template*, and the model is a
 * materialized day-by-day calendar that the admin edits directly.
 */
export type VisitSession = 'morning' | 'afternoon'
export type VisitScheduleSource = 'template' | 'manual'
export type VisitBookingStatus = 'pending' | 'confirmed' | 'cancelled' | 'checked_in' | 'no_show'

/** `รอบเยี่ยม` — defined once per facility, because the count differs per prison. */
export const visitRounds = sqliteTable(
  'visit_rounds',
  {
    id: id(),
    prisonId: text('prison_id')
      .notNull()
      .references(() => prisons.id, { onDelete: 'restrict' }),
    roundNo: integer('round_no').notNull(),
    label: text('label').notNull(),
    session: text('session').$type<VisitSession>().notNull().default('morning'),
    /** `HH:MM`, Bangkok wall clock. Never a timestamp: a round is a time of day. */
    startTime: text('start_time').notNull(),
    endTime: text('end_time').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: bool('is_active', true),
    ...timestamps()
  },
  (t) => [
    uniqueIndex('uq_visit_rounds_no').on(t.prisonId, t.roundNo),
    index('idx_visit_rounds_prison').on(t.prisonId, t.sortOrder)
  ]
)

/** The optional recurring pattern that seeds p.12's grid, e.g. Mon AM → แดน 6. */
export const visitScheduleTemplates = sqliteTable(
  'visit_schedule_templates',
  {
    id: id(),
    prisonId: text('prison_id')
      .notNull()
      .references(() => prisons.id, { onDelete: 'restrict' }),
    /** 0 = Sunday, matching `Date#getUTCDay` on a Bangkok-shifted value. */
    weekday: integer('weekday').notNull(),
    roundId: text('round_id')
      .notNull()
      .references(() => visitRounds.id, { onDelete: 'cascade' }),
    zoneId: text('zone_id')
      .notNull()
      .references(() => zones.id, { onDelete: 'cascade' }),
    capacity: integer('capacity').notNull().default(20),
    isActive: bool('is_active', true),
    ...timestamps()
  },
  (t) => [
    uniqueIndex('uq_visit_templates_cell').on(t.prisonId, t.weekday, t.roundId, t.zoneId),
    index('idx_visit_templates_prison').on(t.prisonId, t.weekday)
  ]
)

/**
 * One row = one bookable cell, with its own capacity and its own counter.
 * Booking reads this table and nothing else — never the template, never a
 * weekday rule evaluated at request time. That is what makes a manual override
 * trivially correct and the capacity check a single-row UPDATE.
 */
export const visitScheduleDays = sqliteTable(
  'visit_schedule_days',
  {
    id: id(),
    prisonId: text('prison_id')
      .notNull()
      .references(() => prisons.id, { onDelete: 'restrict' }),
    /** `YYYY-MM-DD` in Bangkok local time — the grid's column key. */
    date: text('date').notNull(),
    roundId: text('round_id')
      .notNull()
      .references(() => visitRounds.id, { onDelete: 'restrict' }),
    zoneId: text('zone_id')
      .notNull()
      .references(() => zones.id, { onDelete: 'restrict' }),
    capacity: integer('capacity').notNull().default(20),
    bookedCount: integer('booked_count').notNull().default(0),
    isClosed: bool('is_closed', false),
    note: text('note'),
    /** Manual edits win, permanently: the materialize job never touches them. */
    source: text('source').$type<VisitScheduleSource>().notNull().default('template'),
    ...timestamps(),
    createdBy: text('created_by'),
    updatedBy: text('updated_by')
  },
  (t) => [
    uniqueIndex('uq_visit_days_cell').on(t.prisonId, t.date, t.roundId, t.zoneId),
    // The week grid and the availability API both read exactly this.
    index('idx_visit_days_grid').on(t.prisonId, t.date, t.roundId),
    index('idx_visit_days_zone').on(t.prisonId, t.zoneId, t.date),
    // The backstop if anyone ever writes the increment carelessly (§4.6).
    check('ck_visit_days_capacity', sql`booked_count >= 0 AND booked_count <= capacity`)
  ]
)

export const visitBookings = sqliteTable(
  'visit_bookings',
  {
    id: id(),
    /** `{PRISON_CODE}-V{YYMM}-{SEQ}` — read aloud at the gate. */
    bookingNo: text('booking_no').notNull(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    inmateId: text('inmate_id')
      .notNull()
      .references(() => inmates.id, { onDelete: 'restrict' }),
    prisonId: text('prison_id')
      .notNull()
      .references(() => prisons.id, { onDelete: 'restrict' }),
    zoneId: text('zone_id').references(() => zones.id, { onDelete: 'set null' }),
    scheduleDayId: text('schedule_day_id')
      .notNull()
      .references(() => visitScheduleDays.id, { onDelete: 'restrict' }),

    /** Denormalised from the cell so the gate list needs no joins (§4.1). */
    visitDate: text('visit_date').notNull(),
    roundId: text('round_id')
      .notNull()
      .references(() => visitRounds.id, { onDelete: 'restrict' }),
    session: text('session').$type<VisitSession>().notNull(),
    startTime: text('start_time').notNull(),
    endTime: text('end_time').notNull(),
    /** Epoch ms of the round's start — cutoff and reminder read this, not text. */
    startsAt: ts('starts_at').notNull(),
    roundLabelSnapshot: text('round_label_snapshot').notNull(),
    zoneNameSnapshot: text('zone_name_snapshot'),
    inmateCodeSnapshot: text('inmate_code_snapshot').notNull(),
    inmateNameSnapshot: text('inmate_name_snapshot').notNull(),

    visitorName: text('visitor_name').notNull(),
    contactPhone: text('contact_phone').notNull(),
    lineIdText: text('line_id_text'),
    /** Informational for the gate sheet — capacity counts bookings, not heads. */
    visitorCount: integer('visitor_count').notNull().default(1),
    note: text('note'),

    status: text('status').$type<VisitBookingStatus>().notNull().default('confirmed'),
    cancelledReason: text('cancelled_reason'),
    cancelledAt: ts('cancelled_at'),
    checkedInAt: ts('checked_in_at'),
    /** Set by `visit.reminder` so a re-run never notifies the same family twice. */
    remindedAt: ts('reminded_at'),
    ...timestamps(),
    createdBy: text('created_by'),
    updatedBy: text('updated_by')
  },
  (t) => [
    uniqueIndex('uq_visit_bookings_no').on(t.bookingNo),
    /**
     * §4.6's "one visit per inmate per day", narrowed to live bookings: a
     * cancelled slot must be re-bookable, and a full UNIQUE would forbid that.
     */
    uniqueIndex('uq_visit_bookings_inmate_day')
      .on(t.inmateId, t.visitDate)
      .where(sql`status in ('pending','confirmed','checked_in')`),
    index('idx_visit_bookings_day').on(t.scheduleDayId, t.status),
    index('idx_visit_bookings_gate').on(t.prisonId, t.visitDate, t.status),
    index('idx_visit_bookings_customer').on(t.customerId, t.visitDate),
    index('idx_visit_bookings_inmate').on(t.inmateId, t.visitDate),
    index('idx_visit_bookings_reminder').on(t.status, t.startsAt, t.remindedAt),
    /** Department-wide report range scan (§7). */
    index('idx_visit_bookings_date').on(t.visitDate)
  ]
)

/* ── relations ─────────────────────────────────────────────────────────── */

export const visitRoundsRelations = relations(visitRounds, ({ one, many }) => ({
  prison: one(prisons, { fields: [visitRounds.prisonId], references: [prisons.id] }),
  days: many(visitScheduleDays),
  templates: many(visitScheduleTemplates)
}))

export const visitScheduleTemplatesRelations = relations(visitScheduleTemplates, ({ one }) => ({
  prison: one(prisons, { fields: [visitScheduleTemplates.prisonId], references: [prisons.id] }),
  round: one(visitRounds, {
    fields: [visitScheduleTemplates.roundId],
    references: [visitRounds.id]
  }),
  zone: one(zones, { fields: [visitScheduleTemplates.zoneId], references: [zones.id] })
}))

export const visitScheduleDaysRelations = relations(visitScheduleDays, ({ one, many }) => ({
  prison: one(prisons, { fields: [visitScheduleDays.prisonId], references: [prisons.id] }),
  round: one(visitRounds, { fields: [visitScheduleDays.roundId], references: [visitRounds.id] }),
  zone: one(zones, { fields: [visitScheduleDays.zoneId], references: [zones.id] }),
  bookings: many(visitBookings)
}))

export const visitBookingsRelations = relations(visitBookings, ({ one }) => ({
  customer: one(customers, { fields: [visitBookings.customerId], references: [customers.id] }),
  inmate: one(inmates, { fields: [visitBookings.inmateId], references: [inmates.id] }),
  prison: one(prisons, { fields: [visitBookings.prisonId], references: [prisons.id] }),
  zone: one(zones, { fields: [visitBookings.zoneId], references: [zones.id] }),
  round: one(visitRounds, { fields: [visitBookings.roundId], references: [visitRounds.id] }),
  scheduleDay: one(visitScheduleDays, {
    fields: [visitBookings.scheduleDayId],
    references: [visitScheduleDays.id]
  })
}))
