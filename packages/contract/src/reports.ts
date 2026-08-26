import { z } from 'zod'
import { Ulid } from './common.js'
import { IsoDate } from './visits.js'

/**
 * §7 — the seven reports on p.12. All XLSX, all generated off the request
 * thread through the `jobs` table, all stamped with the filters that produced
 * them so a printed copy can be reproduced exactly.
 */
export const ReportKind = z.enum([
  /** 1. รายงานการขาย — one row per order. */
  'sales',
  /** 2. สรุปการขาย — one row per order line. */
  'sales_detail',
  /** 3. รายงานสินค้าที่มีการขาย — product × แดน × กองงาน. */
  'products',
  /** 4. รายงานการเยี่ยม */
  'visits',
  /** 5. รายงานจดหมายอิเล็กทรอนิกส์ */
  'letters',
  /** 6. รายงานการชำระเงิน — succeeded vs failed. */
  'payments',
  /** 7. รายงานสรุปยอดการฝากเงิน */
  'deposits'
])
export type ReportKind = z.infer<typeof ReportKind>

export const REPORT_LABEL: Record<ReportKind, string> = {
  sales: 'รายงานการขาย',
  sales_detail: 'สรุปการขาย',
  products: 'รายงานสินค้าที่มีการขาย',
  visits: 'รายงานการเยี่ยม',
  letters: 'รายงานจดหมายอิเล็กทรอนิกส์',
  payments: 'รายงานการชำระเงิน',
  deposits: 'รายงานสรุปยอดการฝากเงิน'
}

/** Reports 3–7 are period aggregates; `month` is how staff actually read them. */
export const ReportGrouping = z.enum(['none', 'month', 'year'])
export type ReportGrouping = z.infer<typeof ReportGrouping>

export const ReportRequestInput = z.object({
  prisonId: Ulid.nullable().optional(),
  zoneId: Ulid.optional(),
  shopId: Ulid.optional(),
  /** Bangkok wall-clock dates, inclusive both ends. */
  from: IsoDate,
  to: IsoDate,
  groupBy: ReportGrouping.default('month')
})
export type ReportRequestInput = z.infer<typeof ReportRequestInput>

export const ReportJobStatus = z.enum(['pending', 'running', 'succeeded', 'failed', 'cancelled'])
export type ReportJobStatus = z.infer<typeof ReportJobStatus>

export const ReportJob = z.object({
  id: Ulid,
  kind: ReportKind,
  label: z.string(),
  status: ReportJobStatus,
  filters: ReportRequestInput,
  prisonId: Ulid.nullable(),
  requestedBy: z.string().nullable(),
  /** Populated once the job succeeds. */
  filename: z.string().nullable(),
  rowCount: z.number().int().nullable(),
  bytes: z.number().int().nullable(),
  error: z.string().nullable(),
  createdAt: z.number(),
  completedAt: z.number().nullable()
})
export type ReportJob = z.infer<typeof ReportJob>
