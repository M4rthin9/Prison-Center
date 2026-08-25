import { relations } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { bool, id, jsonText, timestamps, ts } from './_shared.js'

/* ── prisons / zones / work divisions ─────────────────────────────────── */

export const prisons = sqliteTable(
  'prisons',
  {
    id: id(),
    code: text('code').notNull(),
    nameTh: text('name_th').notNull(),
    nameEn: text('name_en'),
    address: text('address'),
    province: text('province'),
    phone: text('phone'),
    isActive: bool('is_active', true),
    ...timestamps()
  },
  (t) => [uniqueIndex('uq_prisons_code').on(t.code)]
)

/** แดน */
export const zones = sqliteTable(
  'zones',
  {
    id: id(),
    prisonId: text('prison_id')
      .notNull()
      .references(() => prisons.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    code: text('code'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: bool('is_active', true),
    ...timestamps()
  },
  (t) => [
    uniqueIndex('uq_zones_prison_name').on(t.prisonId, t.name),
    index('idx_zones_prison').on(t.prisonId, t.sortOrder)
  ]
)

/** กองงาน */
export const workDivisions = sqliteTable(
  'work_divisions',
  {
    id: id(),
    prisonId: text('prison_id')
      .notNull()
      .references(() => prisons.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    code: text('code'),
    isActive: bool('is_active', true),
    ...timestamps()
  },
  (t) => [uniqueIndex('uq_work_divisions_prison_name').on(t.prisonId, t.name)]
)

/* ── inmates ───────────────────────────────────────────────────────────── */

export type InmateStatus = 'active' | 'transferred' | 'released' | 'deceased'

export const inmates = sqliteTable(
  'inmates',
  {
    id: id(),
    prisonId: text('prison_id')
      .notNull()
      .references(() => prisons.id, { onDelete: 'restrict' }),
    zoneId: text('zone_id').references(() => zones.id, { onDelete: 'set null' }),
    workDivisionId: text('work_division_id').references(() => workDivisions.id, {
      onDelete: 'set null'
    }),
    inmateCode: text('inmate_code').notNull(),
    fullName: text('full_name').notNull(),
    status: text('status').$type<InmateStatus>().notNull().default('active'),
    releasedAt: ts('released_at'),

    // ── DOC sync (decision #3) ──
    externalId: text('external_id'),
    externalSource: text('external_source'),
    syncedAt: ts('synced_at'),
    /** Hash of the incoming row: unchanged rows are skipped without a diff. */
    syncHash: text('sync_hash'),
    /** Staff-corrected fields must survive the next import. */
    isLocallyEdited: bool('is_locally_edited', false),

    /** Soft delete only. A truncated export must never wipe live inmates. */
    deletedAt: ts('deleted_at'),
    ...timestamps(),
    createdBy: text('created_by'),
    updatedBy: text('updated_by')
  },
  (t) => [
    uniqueIndex('uq_inmates_prison_code').on(t.prisonId, t.inmateCode),
    uniqueIndex('uq_inmates_external').on(t.externalSource, t.externalId),
    index('idx_inmates_external').on(t.externalSource, t.externalId),
    index('idx_inmates_prison_zone').on(t.prisonId, t.zoneId, t.status),
    index('idx_inmates_name').on(t.fullName)
  ]
)

/* ── import audit trail (Phase 0b writes these) ───────────────────────── */

export const inmateImportRuns = sqliteTable(
  'inmate_import_runs',
  {
    id: id(),
    prisonId: text('prison_id')
      .notNull()
      .references(() => prisons.id, { onDelete: 'restrict' }),
    source: text('source').notNull(),
    /** The uploaded file itself, kept so `apply` re-reads exactly what was previewed. */
    fileKey: text('file_key'),
    fileName: text('file_name'),
    /** SHA-256 of the upload. `apply` refuses if the stored bytes ever differ. */
    fileHash: text('file_hash'),
    /** The options the dry run was computed with — apply reuses them verbatim. */
    optionsJson: jsonText<Record<string, unknown>>('options_json'),
    status: text('status').$type<'dry_run' | 'applied' | 'failed'>().notNull().default('dry_run'),
    startedAt: ts('started_at').notNull(),
    finishedAt: ts('finished_at'),
    rowsTotal: integer('rows_total').notNull().default(0),
    rowsCreated: integer('rows_created').notNull().default(0),
    rowsUpdated: integer('rows_updated').notNull().default(0),
    rowsSkipped: integer('rows_skipped').notNull().default(0),
    rowsErrored: integer('rows_errored').notNull().default(0),
    errorReportKey: text('error_report_key'),
    runBy: text('run_by'),
    ...timestamps()
  },
  (t) => [index('idx_import_runs_prison').on(t.prisonId, t.startedAt)]
)

export const inmateImportRows = sqliteTable(
  'inmate_import_rows',
  {
    id: id(),
    runId: text('run_id')
      .notNull()
      .references(() => inmateImportRuns.id, { onDelete: 'cascade' }),
    rowNo: integer('row_no').notNull(),
    rawJson: jsonText<Record<string, unknown>>('raw_json'),
    result: text('result')
      .$type<'created' | 'updated' | 'skipped' | 'conflict' | 'error'>()
      .notNull(),
    message: text('message'),
    inmateId: text('inmate_id'),
    createdAt: ts('created_at')
      .notNull()
      .$defaultFn(() => Date.now())
  },
  (t) => [index('idx_import_rows_run').on(t.runId, t.rowNo)]
)

/* ── relations ─────────────────────────────────────────────────────────── */

export const prisonsRelations = relations(prisons, ({ many }) => ({
  zones: many(zones),
  workDivisions: many(workDivisions),
  inmates: many(inmates)
}))

export const zonesRelations = relations(zones, ({ one, many }) => ({
  prison: one(prisons, { fields: [zones.prisonId], references: [prisons.id] }),
  inmates: many(inmates)
}))

export const inmatesRelations = relations(inmates, ({ one }) => ({
  prison: one(prisons, { fields: [inmates.prisonId], references: [prisons.id] }),
  zone: one(zones, { fields: [inmates.zoneId], references: [zones.id] }),
  workDivision: one(workDivisions, {
    fields: [inmates.workDivisionId],
    references: [workDivisions.id]
  })
}))
