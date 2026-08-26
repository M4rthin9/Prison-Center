import { and, count, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import type { SQLiteColumn } from 'drizzle-orm/sqlite-core'
import type {
  DashboardPeriod,
  DashboardQueues,
  DashboardSeriesPoint,
  DashboardSummary,
  DepositsTile,
  LettersTile,
  OrdersTile,
  VisitsTile
} from '@pc/contract'
import { db as defaultDb, type Db } from '../../db/client.js'
import {
  customerInmates,
  depositCards,
  deposits,
  letterPurchases,
  letters,
  orders,
  payments,
  prisons,
  visitBookings,
  visitScheduleDays
} from '../../db/schema/index.js'
import { badRequest } from '../../lib/errors.js'
import { addDays, bangkokDate, bangkokEpoch, dateRange, DAY, now } from '../../lib/time.js'

export interface DateWindow {
  from: string
  to: string
  fromMs: number
  toMs: number
}

/**
 * The period selector, resolved in Bangkok wall-clock time. Timestamps are
 * stored UTC; a "today" that starts at 07:00 local is the classic way these
 * tiles end up disagreeing with the lists underneath them.
 */
export function resolveWindow(
  period: DashboardPeriod,
  from?: string,
  to?: string,
  today = bangkokDate()
): DateWindow {
  let start = today
  let end = today

  switch (period) {
    case 'today':
      break
    case 'week':
      start = addDays(today, -6)
      break
    case 'month':
      start = today.slice(0, 8) + '01'
      break
    case 'year':
      start = today.slice(0, 4) + '-01-01'
      break
    case 'custom': {
      if (!from || !to) throw badRequest('ช่วงเวลาแบบกำหนดเองต้องระบุทั้ง from และ to')
      if (from > to) throw badRequest('วันเริ่มต้นต้องไม่หลังวันสิ้นสุด')
      start = from
      end = to
      break
    }
  }

  return {
    from: start,
    to: end,
    fromMs: bangkokEpoch(start),
    // Inclusive of the last day: everything before midnight that starts the
    // next one.
    toMs: bangkokEpoch(end) + DAY - 1
  }
}

const scoped = (column: SQLiteColumn, prisonId: string | null) =>
  prisonId ? eq(column, prisonId) : undefined

const inWindow = (column: SQLiteColumn, w: DateWindow) =>
  and(gte(column, w.fromMs), lte(column, w.toMs))

/** The Bangkok day an epoch-ms column falls on — the series grouping key. */
const bangkokDay = (column: SQLiteColumn) =>
  sql<string>`strftime('%Y-%m-%d', datetime(${column} / 1000, 'unixepoch', '+7 hours'))`

/* ── the four tiles ────────────────────────────────────────────────────── */

export function ordersTile(prisonId: string | null, w: DateWindow, database: Db): OrdersTile {
  const rows = database
    .select({
      paymentStatus: orders.paymentStatus,
      fulfillmentStatus: orders.fulfillmentStatus,
      n: count(),
      total: sql<number>`coalesce(sum(${orders.totalSatang}), 0)`
    })
    .from(orders)
    .where(and(scoped(orders.prisonId, prisonId), inWindow(orders.orderedAt, w)))
    .groupBy(orders.paymentStatus, orders.fulfillmentStatus)
    .all()

  const pick = (pred: (r: (typeof rows)[number]) => boolean) =>
    rows.filter(pred).reduce((acc, r) => ({ n: acc.n + r.n, total: acc.total + r.total }), {
      n: 0,
      total: 0
    })

  const all = pick(() => true)
  const paid = pick((r) => r.paymentStatus === 'paid')
  const cancelled = pick((r) => r.fulfillmentStatus === 'cancelled')

  return {
    count: all.n,
    paidCount: paid.n,
    unpaidCount: pick((r) => r.paymentStatus === 'unpaid' || r.paymentStatus === 'awaiting_verify')
      .n,
    cancelledCount: cancelled.n,
    // Finance reads this tile against the bank, so it counts settled money
    // only — never the value of a basket nobody has paid for.
    paidSatang: paid.total,
    grossSatang: all.total,
    awaitingFulfillmentCount: pick(
      (r) =>
        r.paymentStatus === 'paid' &&
        (r.fulfillmentStatus === 'new' || r.fulfillmentStatus === 'preparing')
    ).n
  }
}

export function visitsTile(prisonId: string | null, w: DateWindow, database: Db): VisitsTile {
  const rows = database
    .select({ status: visitBookings.status, n: count() })
    .from(visitBookings)
    .where(
      and(
        scoped(visitBookings.prisonId, prisonId),
        gte(visitBookings.visitDate, w.from),
        lte(visitBookings.visitDate, w.to)
      )
    )
    .groupBy(visitBookings.status)
    .all()

  const capacityTotal =
    database
      .select({ total: sql<number>`coalesce(sum(${visitScheduleDays.capacity}), 0)` })
      .from(visitScheduleDays)
      .where(
        and(
          scoped(visitScheduleDays.prisonId, prisonId),
          eq(visitScheduleDays.isClosed, false),
          gte(visitScheduleDays.date, w.from),
          lte(visitScheduleDays.date, w.to)
        )
      )
      .get()?.total ?? 0

  const by = (s: string) => rows.find((r) => r.status === s)?.n ?? 0
  // A cancellation gave its seat back, so it must not inflate utilisation.
  const bookedCount = by('pending') + by('confirmed') + by('checked_in') + by('no_show')

  return {
    count: rows.reduce((acc, r) => acc + r.n, 0),
    bookedCount,
    checkedInCount: by('checked_in'),
    cancelledCount: by('cancelled'),
    noShowCount: by('no_show'),
    capacityTotal,
    utilisation: capacityTotal > 0 ? Math.round((bookedCount / capacityTotal) * 1000) / 1000 : 0
  }
}

export function lettersTile(prisonId: string | null, w: DateWindow, database: Db): LettersTile {
  const rows = database
    .select({ direction: letters.direction, status: letters.status, n: count() })
    .from(letters)
    .where(and(scoped(letters.prisonId, prisonId), inWindow(letters.createdAt, w)))
    .groupBy(letters.direction, letters.status)
    .all()

  const sum = (pred: (r: (typeof rows)[number]) => boolean) =>
    rows.filter(pred).reduce((acc, r) => acc + r.n, 0)

  const creditsSoldSatang =
    database
      .select({ total: sql<number>`coalesce(sum(${letterPurchases.priceSatang}), 0)` })
      .from(letterPurchases)
      .where(
        and(
          eq(letterPurchases.status, 'paid'),
          scoped(letterPurchases.prisonId, prisonId),
          inWindow(letterPurchases.createdAt, w)
        )
      )
      .get()?.total ?? 0

  return {
    count: sum(() => true),
    outboundCount: sum((r) => r.direction === 'to_prison'),
    inboundCount: sum((r) => r.direction === 'to_home'),
    awaitingPrintCount: sum((r) => r.status === 'queued' || r.status === 'pending_print'),
    printedCount: sum((r) => r.status === 'printed'),
    deliveredCount: sum((r) => r.status === 'delivered'),
    creditsSoldSatang
  }
}

export function depositsTile(prisonId: string | null, w: DateWindow, database: Db): DepositsTile {
  const rows = database
    .select({
      status: deposits.status,
      n: count(),
      total: sql<number>`coalesce(sum(${deposits.amountSatang}), 0)`
    })
    .from(deposits)
    .where(and(scoped(deposits.prisonId, prisonId), inWindow(deposits.createdAt, w)))
    .groupBy(deposits.status)
    .all()

  const by = (s: string) => rows.find((r) => r.status === s)
  return {
    count: rows.reduce((acc, r) => acc + r.n, 0),
    pendingCount: by('pending')?.n ?? 0,
    reviewingCount: by('reviewing')?.n ?? 0,
    completedCount: by('completed')?.n ?? 0,
    // Money whose slip has passed, credited to the inmate or not yet.
    receivedSatang: (by('reviewing')?.total ?? 0) + (by('completed')?.total ?? 0),
    completedSatang: by('completed')?.total ?? 0
  }
}

/* ── the period chart ──────────────────────────────────────────────────── */

export function series(
  prisonId: string | null,
  w: DateWindow,
  database: Db
): DashboardSeriesPoint[] {
  const empty = () => ({
    orders: 0,
    paidSatang: 0,
    visits: 0,
    letters: 0,
    deposits: 0,
    depositSatang: 0
  })
  const byDate = new Map<string, ReturnType<typeof empty>>()
  const at = (date: string) => {
    let row = byDate.get(date)
    if (!row) byDate.set(date, (row = empty()))
    return row
  }

  for (const r of database
    .select({
      date: bangkokDay(orders.orderedAt),
      n: count(),
      paid: sql<number>`coalesce(sum(case when ${orders.paymentStatus} = 'paid' then ${orders.totalSatang} else 0 end), 0)`
    })
    .from(orders)
    .where(and(scoped(orders.prisonId, prisonId), inWindow(orders.orderedAt, w)))
    .groupBy(bangkokDay(orders.orderedAt))
    .all()) {
    const row = at(r.date)
    row.orders = r.n
    row.paidSatang = r.paid
  }

  // Visits are counted on the day of the *visit*, not the day it was booked —
  // that is the number the gate staff recognise.
  for (const r of database
    .select({ date: visitBookings.visitDate, n: count() })
    .from(visitBookings)
    .where(
      and(
        scoped(visitBookings.prisonId, prisonId),
        inArray(visitBookings.status, ['pending', 'confirmed', 'checked_in', 'no_show']),
        gte(visitBookings.visitDate, w.from),
        lte(visitBookings.visitDate, w.to)
      )
    )
    .groupBy(visitBookings.visitDate)
    .all()) {
    at(r.date).visits = r.n
  }

  for (const r of database
    .select({ date: bangkokDay(letters.createdAt), n: count() })
    .from(letters)
    .where(and(scoped(letters.prisonId, prisonId), inWindow(letters.createdAt, w)))
    .groupBy(bangkokDay(letters.createdAt))
    .all()) {
    at(r.date).letters = r.n
  }

  for (const r of database
    .select({
      date: bangkokDay(deposits.createdAt),
      n: count(),
      total: sql<number>`coalesce(sum(case when ${deposits.status} in ('reviewing','completed') then ${deposits.amountSatang} else 0 end), 0)`
    })
    .from(deposits)
    .where(and(scoped(deposits.prisonId, prisonId), inWindow(deposits.createdAt, w)))
    .groupBy(bangkokDay(deposits.createdAt))
    .all()) {
    const row = at(r.date)
    row.deposits = r.n
    row.depositSatang = r.total
  }

  // Every day in the window gets a point, including the empty ones — a chart
  // that silently drops quiet days lies about the shape of the week.
  return dateRange(w.from, w.to).map((date) => ({ date, ...(byDate.get(date) ?? empty()) }))
}

/* ── work waiting on a human ───────────────────────────────────────────── */

export function queues(prisonId: string | null, database: Db): DashboardQueues {
  const countOf = (rows: { n: number } | undefined) => rows?.n ?? 0

  const paymentsAwaitingReview = database
    .select({ n: count() })
    .from(payments)
    .where(and(eq(payments.status, 'awaiting_verify'), scoped(payments.prisonId, prisonId)))
    .get()

  const depositsAwaitingReview = database
    .select({ n: count() })
    .from(deposits)
    .where(and(eq(deposits.status, 'reviewing'), scoped(deposits.prisonId, prisonId)))
    .get()

  const lettersAwaitingPrint = database
    .select({ n: count() })
    .from(letters)
    .where(
      and(inArray(letters.status, ['queued', 'pending_print']), scoped(letters.prisonId, prisonId))
    )
    .get()

  const ordersAwaitingFulfillment = database
    .select({ n: count() })
    .from(orders)
    .where(
      and(
        eq(orders.paymentStatus, 'paid'),
        inArray(orders.fulfillmentStatus, ['new', 'preparing']),
        scoped(orders.prisonId, prisonId)
      )
    )
    .get()

  // The link request is the gate for money, letters and visits (§4.1b), so a
  // backlog here blocks everything else the family is trying to do.
  const inmateLinksAwaitingVerify = database
    .select({ n: count() })
    .from(customerInmates)
    .where(eq(customerInmates.verifyStatus, 'pending'))
    .get()

  const depositCardsAwaitingReview = database
    .select({ n: count() })
    .from(depositCards)
    .where(and(eq(depositCards.status, 'pending'), scoped(depositCards.prisonId, prisonId)))
    .get()

  return {
    paymentsAwaitingReview: countOf(paymentsAwaitingReview),
    depositsAwaitingReview: countOf(depositsAwaitingReview),
    lettersAwaitingPrint: countOf(lettersAwaitingPrint),
    ordersAwaitingFulfillment: countOf(ordersAwaitingFulfillment),
    inmateLinksAwaitingVerify: countOf(inmateLinksAwaitingVerify),
    depositCardsAwaitingReview: countOf(depositCardsAwaitingReview)
  }
}

export function dashboardSummary(
  prisonId: string | null,
  query: { period: DashboardPeriod; from?: string; to?: string },
  database: Db = defaultDb()
): DashboardSummary {
  const w = resolveWindow(query.period, query.from, query.to)
  const prisonName = prisonId
    ? (database
        .select({ name: prisons.nameTh })
        .from(prisons)
        .where(eq(prisons.id, prisonId))
        .get()?.name ?? null)
    : null

  return {
    prisonId,
    prisonName,
    period: query.period,
    from: w.from,
    to: w.to,
    orders: ordersTile(prisonId, w, database),
    visits: visitsTile(prisonId, w, database),
    letters: lettersTile(prisonId, w, database),
    deposits: depositsTile(prisonId, w, database),
    series: series(prisonId, w, database),
    queues: queues(prisonId, database),
    generatedAt: now()
  }
}
