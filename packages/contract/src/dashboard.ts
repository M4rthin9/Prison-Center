import { z } from 'zod'
import { IsoDate } from './visits.js'
import { Ulid } from './common.js'

/**
 * p.11 — the four tiles, one period selector driving all of them. Every number
 * is counted from the business tables at read time; nothing here is a
 * pre-aggregated column that can drift away from what the lists show.
 */
export const DashboardPeriod = z.enum(['today', 'week', 'month', 'year', 'custom'])
export type DashboardPeriod = z.infer<typeof DashboardPeriod>

export const DashboardQuery = z.object({
  prisonId: Ulid.optional(),
  period: DashboardPeriod.default('month'),
  /** Bangkok wall-clock dates, inclusive. Required when `period=custom`. */
  from: IsoDate.optional(),
  to: IsoDate.optional()
})
export type DashboardQuery = z.infer<typeof DashboardQuery>

export const OrdersTile = z.object({
  count: z.number().int(),
  paidCount: z.number().int(),
  unpaidCount: z.number().int(),
  cancelledCount: z.number().int(),
  /** Sales that are actually paid — the only figure finance will accept. */
  paidSatang: z.number().int(),
  grossSatang: z.number().int(),
  awaitingFulfillmentCount: z.number().int()
})
export type OrdersTile = z.infer<typeof OrdersTile>

export const VisitsTile = z.object({
  count: z.number().int(),
  bookedCount: z.number().int(),
  checkedInCount: z.number().int(),
  cancelledCount: z.number().int(),
  noShowCount: z.number().int(),
  capacityTotal: z.number().int(),
  /** booked ÷ capacity, 0–1. The number that decides whether to add a round. */
  utilisation: z.number()
})
export type VisitsTile = z.infer<typeof VisitsTile>

export const LettersTile = z.object({
  count: z.number().int(),
  outboundCount: z.number().int(),
  inboundCount: z.number().int(),
  awaitingPrintCount: z.number().int(),
  printedCount: z.number().int(),
  deliveredCount: z.number().int(),
  creditsSoldSatang: z.number().int()
})
export type LettersTile = z.infer<typeof LettersTile>

export const DepositsTile = z.object({
  count: z.number().int(),
  pendingCount: z.number().int(),
  reviewingCount: z.number().int(),
  completedCount: z.number().int(),
  receivedSatang: z.number().int(),
  completedSatang: z.number().int()
})
export type DepositsTile = z.infer<typeof DepositsTile>

/** One point per Bangkok day in the selected period — the p.11 period chart. */
export const DashboardSeriesPoint = z.object({
  date: IsoDate,
  orders: z.number().int(),
  paidSatang: z.number().int(),
  visits: z.number().int(),
  letters: z.number().int(),
  deposits: z.number().int(),
  depositSatang: z.number().int()
})
export type DashboardSeriesPoint = z.infer<typeof DashboardSeriesPoint>

/** Work waiting on a human right now — deliberately *not* period-filtered. */
export const DashboardQueues = z.object({
  paymentsAwaitingReview: z.number().int(),
  depositsAwaitingReview: z.number().int(),
  lettersAwaitingPrint: z.number().int(),
  ordersAwaitingFulfillment: z.number().int(),
  inmateLinksAwaitingVerify: z.number().int(),
  depositCardsAwaitingReview: z.number().int()
})
export type DashboardQueues = z.infer<typeof DashboardQueues>

export const DashboardSummary = z.object({
  prisonId: Ulid.nullable(),
  prisonName: z.string().nullable(),
  period: DashboardPeriod,
  from: IsoDate,
  to: IsoDate,
  orders: OrdersTile,
  visits: VisitsTile,
  letters: LettersTile,
  deposits: DepositsTile,
  series: z.array(DashboardSeriesPoint),
  queues: DashboardQueues,
  generatedAt: z.number()
})
export type DashboardSummary = z.infer<typeof DashboardSummary>
