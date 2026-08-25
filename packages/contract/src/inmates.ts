import { z } from 'zod'
import { Ulid } from './common.js'
import { InmateStatus } from './facility.js'

/* ── admin CRUD ────────────────────────────────────────────────────────── */

export const InmateRow = z.object({
  id: Ulid,
  inmateCode: z.string(),
  fullName: z.string(),
  prisonId: Ulid,
  prisonName: z.string(),
  zoneId: Ulid.nullable(),
  zoneName: z.string().nullable(),
  workDivisionId: Ulid.nullable(),
  workDivisionName: z.string().nullable(),
  status: InmateStatus,
  releasedAt: z.number().nullable(),
  /** DOC sync bookkeeping (decision #3). NULL = created by hand in the dashboard. */
  externalId: z.string().nullable(),
  externalSource: z.string().nullable(),
  syncedAt: z.number().nullable(),
  /** Set by any manual edit — the importer will not overwrite the name again. */
  isLocallyEdited: z.boolean(),
  /** Number of relatives linked, verified or not. Blocks a hard delete. */
  linkCount: z.number().int(),
  deletedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type InmateRow = z.infer<typeof InmateRow>

const InmateCode = z
  .string()
  .trim()
  .min(2, 'เลขทะเบียนสั้นเกินไป')
  .max(40)
  .regex(/^[A-Za-z0-9฀-๿./-]+$/, 'เลขทะเบียนมีอักขระที่ใช้ไม่ได้')

export const CreateInmateInput = z.object({
  prisonId: Ulid.optional(),
  inmateCode: InmateCode,
  fullName: z.string().trim().min(2, 'ต้องระบุชื่อ-สกุล').max(160),
  zoneId: Ulid.nullable().optional(),
  workDivisionId: Ulid.nullable().optional(),
  status: InmateStatus.default('active'),
  externalId: z.string().trim().max(60).nullable().optional(),
  externalSource: z.string().trim().max(40).nullable().optional()
})
export type CreateInmateInput = z.infer<typeof CreateInmateInput>

export const UpdateInmateInput = z.object({
  inmateCode: InmateCode.optional(),
  fullName: z.string().trim().min(2).max(160).optional(),
  zoneId: Ulid.nullable().optional(),
  workDivisionId: Ulid.nullable().optional(),
  status: InmateStatus.optional(),
  releasedAt: z.number().nullable().optional(),
  externalId: z.string().trim().max(60).nullable().optional()
})
export type UpdateInmateInput = z.infer<typeof UpdateInmateInput>

/**
 * A transfer is its own verb, not a `prisonId` edit: it moves the zone with the
 * inmate, and every historical order keeps the zone it was placed in (§4.1).
 */
export const TransferInmateInput = z.object({
  toPrisonId: Ulid,
  toZoneId: Ulid.nullable().optional(),
  toWorkDivisionId: Ulid.nullable().optional(),
  reason: z.string().trim().max(200).optional()
})
export type TransferInmateInput = z.infer<typeof TransferInmateInput>

/* ── XLSX / CSV import (phase 0b) ──────────────────────────────────────── */

export const ImportRowResult = z.enum(['created', 'updated', 'skipped', 'conflict', 'error'])
export type ImportRowResult = z.infer<typeof ImportRowResult>

export const ImportRunStatus = z.enum(['dry_run', 'applied', 'failed'])
export type ImportRunStatus = z.infer<typeof ImportRunStatus>

/**
 * What to do with an inmate this facility holds who is **absent** from the
 * file. Default `ignore`, because a truncated export must never be read as a
 * mass release (§4.1 — soft delete only).
 */
export const MissingPolicy = z.enum(['ignore', 'mark_transferred'])
export type MissingPolicy = z.infer<typeof MissingPolicy>

export const ImportOptions = z.object({
  prisonId: Ulid.optional(),
  source: z.string().trim().min(1).max(40).default('doc_xlsx'),
  /** แดน / กองงาน named in the file but not in the database yet. */
  createZones: z.boolean().default(false),
  missingPolicy: MissingPolicy.default('ignore')
})
export type ImportOptions = z.infer<typeof ImportOptions>

export const ImportRunSummary = z.object({
  id: Ulid,
  prisonId: Ulid,
  prisonName: z.string(),
  source: z.string(),
  fileName: z.string().nullable(),
  status: ImportRunStatus,
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
  rowsTotal: z.number().int(),
  rowsCreated: z.number().int(),
  rowsUpdated: z.number().int(),
  rowsSkipped: z.number().int(),
  rowsErrored: z.number().int(),
  hasErrorReport: z.boolean(),
  runBy: Ulid.nullable(),
  runByName: z.string().nullable(),
  options: ImportOptions.nullable()
})
export type ImportRunSummary = z.infer<typeof ImportRunSummary>

export const ImportRowView = z.object({
  rowNo: z.number().int(),
  result: ImportRowResult,
  message: z.string().nullable(),
  inmateId: Ulid.nullable(),
  inmateCode: z.string().nullable(),
  fullName: z.string().nullable(),
  raw: z.record(z.string(), z.unknown()).nullable()
})
export type ImportRowView = z.infer<typeof ImportRowView>

/** An inmate the facility holds that the file does not mention. */
export const ImportMissingRow = z.object({
  inmateId: Ulid,
  inmateCode: z.string(),
  fullName: z.string(),
  zoneName: z.string().nullable()
})
export type ImportMissingRow = z.infer<typeof ImportMissingRow>

export const ImportPreview = z.object({
  run: ImportRunSummary,
  /** Header → canonical field. Unmapped headers are kept verbatim in `raw`. */
  columnMap: z.record(z.string(), z.string()),
  unmappedHeaders: z.array(z.string()),
  rows: z.array(ImportRowView),
  missing: z.array(ImportMissingRow),
  missingTotal: z.number().int()
})
export type ImportPreview = z.infer<typeof ImportPreview>
