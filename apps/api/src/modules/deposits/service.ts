import { and, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm'
import type {
  CreateDepositCardInput,
  CreateDepositInput,
  DepositCard,
  DepositDetail,
  DepositStatus,
  DepositSummaryTotals,
  ReviewDepositCardInput,
  ReviewDepositInput
} from '@pc/contract'
import { db as defaultDb, type Db } from '../../db/client.js'
import {
  customerInmates,
  customers,
  depositCards,
  deposits,
  inmates,
  payments,
  prisons,
  staff,
  zones
} from '../../db/schema/index.js'
import { writeAudit } from '../../lib/audit.js'
import { nextDepositCardNo, nextDepositNo } from '../../lib/counters.js'
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js'
import { formatBaht } from '../../lib/money.js'
import { notify } from '../../lib/notify/index.js'
import { now } from '../../lib/time.js'
import { getSetting } from '../settings/service.js'
import {
  createPaymentFor,
  livePaymentFor,
  toPaymentView,
  voidLivePayments
} from '../payments/service.js'

export interface DepositContext {
  ip?: string | null
  userAgent?: string | null
}

/* ── the two gates ─────────────────────────────────────────────────────── */

/**
 * Money never moves against an unverified relative link (§4.1b). The deposit
 * card is the second gate, and the facility can switch it off per prison.
 */
function assertMayDeposit(customerId: string, inmateId: string, database: Db) {
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

function cardFor(customerId: string, inmateId: string, database: Db) {
  return database
    .select()
    .from(depositCards)
    .where(and(eq(depositCards.customerId, customerId), eq(depositCards.inmateId, inmateId)))
    .get()
}

/* ── deposit cards ─────────────────────────────────────────────────────── */

const cardSelect = {
  id: depositCards.id,
  cardNo: depositCards.cardNo,
  status: depositCards.status,
  customerId: depositCards.customerId,
  customerName: customers.fullName,
  customerPhone: customers.phone,
  inmateId: depositCards.inmateId,
  inmateCode: inmates.inmateCode,
  inmateName: inmates.fullName,
  prisonId: depositCards.prisonId,
  prisonName: prisons.nameTh,
  zoneName: zones.name,
  note: depositCards.note,
  rejectReason: depositCards.rejectReason,
  approvedAt: depositCards.approvedAt,
  createdAt: depositCards.createdAt
}

export function depositCardQuery(db: Db = defaultDb()) {
  return db
    .select(cardSelect)
    .from(depositCards)
    .innerJoin(customers, eq(depositCards.customerId, customers.id))
    .innerJoin(inmates, eq(depositCards.inmateId, inmates.id))
    .innerJoin(prisons, eq(depositCards.prisonId, prisons.id))
    .leftJoin(zones, eq(inmates.zoneId, zones.id))
}

export function depositCardView(id: string, db: Db = defaultDb()): DepositCard {
  const row = depositCardQuery(db).where(eq(depositCards.id, id)).get()
  if (!row) throw notFound('ไม่พบบัตรฝากเงิน')
  return row
}

/** `ลงทะเบียนทำบัตรฝากเงิน` (p.13) — a one-time request, approved by staff. */
export function requestDepositCard(
  customerId: string,
  input: CreateDepositCardInput,
  ctx: DepositContext = {},
  database: Db = defaultDb()
): DepositCard {
  const inmate = assertMayDeposit(customerId, input.inmateId, database)

  const existing = cardFor(customerId, input.inmateId, database)
  if (existing) {
    if (existing.status === 'approved') throw conflict('มีบัตรฝากเงินที่อนุมัติแล้วอยู่')
    if (existing.status === 'pending') throw conflict('คำขอทำบัตรฝากเงินอยู่ระหว่างรอตรวจสอบ')
    // A rejected or suspended card is reopened rather than duplicated — the
    // pair is UNIQUE, and the history stays on one row.
    database
      .update(depositCards)
      .set({
        status: 'pending',
        note: input.note ?? existing.note,
        rejectReason: null,
        updatedAt: now()
      })
      .where(eq(depositCards.id, existing.id))
      .run()
    return depositCardView(existing.id, database)
  }

  const row = database
    .insert(depositCards)
    .values({
      customerId,
      inmateId: input.inmateId,
      prisonId: inmate.prisonId,
      status: 'pending',
      note: input.note ?? null
    })
    .returning()
    .get()

  writeAudit(
    {
      actorType: 'customer',
      actorId: customerId,
      action: 'deposit_card.requested',
      entity: 'deposit_card',
      entityId: row.id,
      prisonId: inmate.prisonId,
      after: { inmateId: input.inmateId },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )
  return depositCardView(row.id, database)
}

export async function reviewDepositCard(
  staffId: string,
  cardId: string,
  input: ReviewDepositCardInput,
  ctx: DepositContext = {},
  database: Db = defaultDb()
): Promise<DepositCard> {
  const before = database.select().from(depositCards).where(eq(depositCards.id, cardId)).get()
  if (!before) throw notFound('ไม่พบบัตรฝากเงิน')
  if (input.status === 'rejected' && !input.reason) {
    throw badRequest('ต้องระบุเหตุผลที่ปฏิเสธ', { reason: ['ต้องระบุเหตุผล'] })
  }

  const at = now()
  const prison = database.select().from(prisons).where(eq(prisons.id, before.prisonId)).get()
  // The number is allocated on first approval and then kept for good: a
  // suspended card that comes back is the same card, not a new one.
  const cardNo =
    input.status === 'approved' && !before.cardNo
      ? nextDepositCardNo(before.prisonId, prison?.code ?? 'XXX', database, at)
      : before.cardNo

  database
    .update(depositCards)
    .set({
      status: input.status,
      cardNo,
      approvedBy: staffId,
      approvedAt: input.status === 'approved' ? at : before.approvedAt,
      rejectReason: input.status === 'approved' ? null : (input.reason ?? null),
      updatedAt: at
    })
    .where(eq(depositCards.id, cardId))
    .run()

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: `deposit_card.${input.status}`,
      entity: 'deposit_card',
      entityId: cardId,
      prisonId: before.prisonId,
      before: { status: before.status },
      after: { status: input.status, cardNo, reason: input.reason },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )

  await notify({
    audience: 'customer',
    recipientId: before.customerId,
    kind: 'deposit.reviewed',
    title:
      input.status === 'approved'
        ? `อนุมัติบัตรฝากเงินแล้ว (${cardNo})`
        : 'บัตรฝากเงินไม่ผ่านการตรวจสอบ',
    body:
      input.status === 'approved'
        ? 'ตอนนี้คุณสามารถฝากเงินให้ผู้ต้องขังรายนี้ได้แล้ว'
        : (input.reason ?? 'กรุณาติดต่อเจ้าหน้าที่'),
    data: { cardId, status: input.status }
  })

  return depositCardView(cardId, database)
}

/* ── deposits ──────────────────────────────────────────────────────────── */

const summarySelect = {
  id: deposits.id,
  depositNo: deposits.depositNo,
  status: deposits.status,
  amountSatang: deposits.amountSatang,
  depositorName: deposits.depositorName,
  customerId: deposits.customerId,
  customerName: customers.fullName,
  customerPhone: customers.phone,
  inmateId: deposits.inmateId,
  inmateCode: deposits.inmateCodeSnapshot,
  inmateName: deposits.inmateNameSnapshot,
  prisonId: deposits.prisonId,
  prisonName: prisons.nameTh,
  zoneName: deposits.zoneNameSnapshot,
  cardNo: depositCards.cardNo,
  createdAt: deposits.createdAt,
  depositedAt: deposits.depositedAt,
  completedAt: deposits.completedAt
}

export function depositSummaryQuery(db: Db = defaultDb()) {
  return db
    .select(summarySelect)
    .from(deposits)
    .innerJoin(customers, eq(deposits.customerId, customers.id))
    .innerJoin(prisons, eq(deposits.prisonId, prisons.id))
    .leftJoin(depositCards, eq(deposits.cardId, depositCards.id))
}

/** Payment statuses for a page of deposits — one query, never one per row. */
export function paymentStatusesFor(rows: { id: string }[], db: Db = defaultDb()) {
  const ids = rows.map((r) => r.id)
  if (ids.length === 0) return new Map<string, string>()
  return new Map(
    db
      .select({ id: deposits.id, status: payments.status })
      .from(deposits)
      .innerJoin(payments, eq(payments.id, deposits.paymentId))
      .where(inArray(deposits.id, ids))
      .all()
      .map((r) => [r.id, r.status] as const)
  )
}

export async function depositDetail(
  depositId: string,
  db: Db = defaultDb()
): Promise<DepositDetail> {
  const row = db.select().from(deposits).where(eq(deposits.id, depositId)).get()
  if (!row) throw notFound('ไม่พบรายการฝากเงิน')
  const summary = depositSummaryQuery(db).where(eq(deposits.id, depositId)).get()!

  const payment = livePaymentFor('deposit', depositId, db)
  const reviewer = row.reviewedBy
    ? db.select().from(staff).where(eq(staff.id, row.reviewedBy)).get()
    : null

  return {
    ...summary,
    paymentStatus: payment?.status ?? null,
    note: row.note,
    rejectReason: row.rejectReason,
    reviewedBy: row.reviewedBy,
    reviewedByName: reviewer?.fullName ?? null,
    reviewedAt: row.reviewedAt,
    payment: payment ? await toPaymentView(payment, db) : null
  }
}

/** Statuses that still occupy one of the per-inmate open slots. */
const OPEN_STATES: DepositStatus[] = ['pending', 'reviewing']

export async function createDeposit(
  customerId: string,
  input: CreateDepositInput,
  ctx: DepositContext = {},
  database: Db = defaultDb()
): Promise<DepositDetail> {
  const at = now()
  const inmate = assertMayDeposit(customerId, input.inmateId, database)
  const scope = { prisonId: inmate.prisonId, db: database }

  const card = cardFor(customerId, input.inmateId, database)
  if (getSetting('deposit.require_card', scope)) {
    if (!card || card.status !== 'approved') {
      throw forbidden('ต้องมีบัตรฝากเงินที่ได้รับอนุมัติก่อนจึงจะฝากเงินได้')
    }
  } else if (card && card.status === 'suspended') {
    throw forbidden('บัตรฝากเงินของคุณถูกระงับ กรุณาติดต่อเจ้าหน้าที่')
  }

  const min = getSetting('deposit.min_satang', scope)
  const max = getSetting('deposit.max_satang', scope)
  if (input.amountSatang < min) throw badRequest(`ยอดฝากขั้นต่ำ ${formatBaht(min)}`)
  if (input.amountSatang > max) throw badRequest(`ยอดฝากสูงสุดต่อครั้ง ${formatBaht(max)}`)

  const open =
    database
      .select({ n: count() })
      .from(deposits)
      .where(
        and(
          eq(deposits.customerId, customerId),
          eq(deposits.inmateId, input.inmateId),
          inArray(deposits.status, OPEN_STATES)
        )
      )
      .get()?.n ?? 0
  if (open >= getSetting('deposit.max_open_per_inmate', scope)) {
    throw conflict('มีรายการฝากเงินที่ยังไม่เสร็จสิ้นอยู่หลายรายการแล้ว')
  }

  const customer = database.select().from(customers).where(eq(customers.id, customerId)).get()
  const zone = inmate.zoneId
    ? database.select().from(zones).where(eq(zones.id, inmate.zoneId)).get()
    : null
  const prison = database.select().from(prisons).where(eq(prisons.id, inmate.prisonId)).get()
  if (!prison) throw notFound('ไม่พบเรือนจำ')

  // BEGIN IMMEDIATE: the deposit number comes from `counters` and is consumed
  // by the insert in one write transaction, exactly like an order number.
  const depositId = database.transaction(
    (tx) => {
      const depositNo = nextDepositNo(prison.id, prison.code, tx, at)
      return tx
        .insert(deposits)
        .values({
          depositNo,
          customerId,
          inmateId: inmate.id,
          cardId: card?.id ?? null,
          prisonId: prison.id,
          zoneId: inmate.zoneId,
          zoneNameSnapshot: zone?.name ?? null,
          inmateCodeSnapshot: inmate.inmateCode,
          inmateNameSnapshot: inmate.fullName,
          depositorName: input.depositorName ?? customer?.fullName ?? '',
          amountSatang: input.amountSatang,
          status: 'pending',
          note: input.note ?? null,
          createdAt: at,
          updatedAt: at
        })
        .returning({ id: deposits.id })
        .get().id
    },
    { behavior: 'immediate' }
  )

  // The payment spine is Phase 2's, unchanged: the only thing this flow knows
  // that an order does not is where the amount comes from.
  const payment = await createPaymentFor(
    {
      purpose: 'deposit',
      purposeId: depositId,
      customerId,
      prisonId: prison.id,
      amountSatang: input.amountSatang,
      inmateCode: inmate.inmateCode,
      channelId: input.channelId,
      action: 'deposit.payment_created'
    },
    ctx,
    database
  )
  database
    .update(deposits)
    .set({ paymentId: payment.id, updatedAt: now() })
    .where(eq(deposits.id, depositId))
    .run()

  writeAudit(
    {
      actorType: 'customer',
      actorId: customerId,
      action: 'deposit.created',
      entity: 'deposit',
      entityId: depositId,
      prisonId: prison.id,
      after: {
        inmateId: inmate.id,
        amountSatang: input.amountSatang,
        paymentNo: payment.paymentNo
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )

  return depositDetail(depositId, database)
}

/**
 * A fresh QR for an existing deposit — the QR expired, or the relative wants a
 * different channel. Never a second deposit: the amount and the number stay.
 */
export async function createDepositPayment(
  customerId: string,
  depositId: string,
  input: { channelId?: string } = {},
  ctx: DepositContext = {},
  database: Db = defaultDb()
): Promise<DepositDetail> {
  const row = database.select().from(deposits).where(eq(deposits.id, depositId)).get()
  if (!row) throw notFound('ไม่พบรายการฝากเงิน')
  if (row.customerId !== customerId) throw forbidden('ไม่มีสิทธิ์เข้าถึงรายการฝากเงินนี้')
  if (row.status !== 'pending') throw conflict('รายการนี้ไม่อยู่ในสถานะที่ต้องชำระเงินแล้ว')

  const payment = await createPaymentFor(
    {
      purpose: 'deposit',
      purposeId: depositId,
      customerId,
      prisonId: row.prisonId,
      amountSatang: row.amountSatang,
      inmateCode: row.inmateCodeSnapshot,
      channelId: input.channelId,
      action: 'deposit.payment_created'
    },
    ctx,
    database
  )
  database
    .update(deposits)
    .set({ paymentId: payment.id, updatedAt: now() })
    .where(eq(deposits.id, depositId))
    .run()

  return depositDetail(depositId, database)
}

/** A relative may abandon a deposit while it is still unpaid, and only then. */
export async function cancelDeposit(
  customerId: string,
  depositId: string,
  database: Db = defaultDb()
): Promise<DepositDetail> {
  const row = database.select().from(deposits).where(eq(deposits.id, depositId)).get()
  if (!row) throw notFound('ไม่พบรายการฝากเงิน')
  if (row.customerId !== customerId) throw forbidden('ไม่มีสิทธิ์เข้าถึงรายการฝากเงินนี้')
  if (row.status !== 'pending') throw conflict('ยกเลิกได้เฉพาะรายการที่ยังไม่ได้ชำระเงิน')

  const payment = livePaymentFor('deposit', depositId, database)
  if (payment && payment.status === 'awaiting_verify') {
    throw conflict('มีสลิปที่รอเจ้าหน้าที่ตรวจสอบอยู่ ยกเลิกไม่ได้')
  }

  const at = now()
  voidLivePayments('deposit', depositId, database)
  database
    .update(deposits)
    .set({ status: 'cancelled', updatedAt: at })
    .where(eq(deposits.id, depositId))
    .run()

  writeAudit(
    {
      actorType: 'customer',
      actorId: customerId,
      action: 'deposit.cancelled',
      entity: 'deposit',
      entityId: depositId,
      prisonId: row.prisonId,
      before: { status: row.status },
      after: { status: 'cancelled' }
    },
    database
  )
  return depositDetail(depositId, database)
}

/* ── the review queue (p.7) ────────────────────────────────────────────── */

const ALLOWED: Record<DepositStatus, DepositStatus[]> = {
  pending: ['rejected'],
  reviewing: ['completed', 'rejected'],
  completed: [],
  rejected: [],
  cancelled: []
}

export async function reviewDeposit(
  staffId: string,
  depositId: string,
  input: ReviewDepositInput,
  ctx: DepositContext = {},
  database: Db = defaultDb()
): Promise<DepositDetail> {
  const before = database.select().from(deposits).where(eq(deposits.id, depositId)).get()
  if (!before) throw notFound('ไม่พบรายการฝากเงิน')
  if (input.status !== before.status && !ALLOWED[before.status].includes(input.status)) {
    throw conflict(`เปลี่ยนสถานะจาก "${before.status}" เป็น "${input.status}" ไม่ได้`)
  }
  if (input.status === 'rejected' && !input.reason) {
    throw badRequest('ต้องระบุเหตุผลที่ปฏิเสธ', { reason: ['ต้องระบุเหตุผล'] })
  }
  // `completed` means the money is in the inmate's account inside the facility.
  // It cannot be reached before the slip has been verified (§4.4).
  if (input.status === 'completed' && !before.depositedAt) {
    throw conflict('ยังไม่ได้รับเงินตามสลิป จึงยังทำรายการเสร็จสิ้นไม่ได้')
  }

  const at = now()
  database
    .update(deposits)
    .set({
      status: input.status,
      reviewedBy: staffId,
      reviewedAt: at,
      rejectReason: input.status === 'rejected' ? (input.reason ?? null) : null,
      completedAt: input.status === 'completed' ? at : before.completedAt,
      updatedBy: staffId,
      updatedAt: at
    })
    .where(eq(deposits.id, depositId))
    .run()

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: `deposit.${input.status}`,
      entity: 'deposit',
      entityId: depositId,
      prisonId: before.prisonId,
      before: { status: before.status },
      after: { status: input.status, reason: input.reason },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )

  await notify({
    audience: 'customer',
    recipientId: before.customerId,
    kind: 'deposit.reviewed',
    title:
      input.status === 'completed'
        ? `ฝากเงิน ${formatBaht(before.amountSatang)} เข้าบัญชีผู้ต้องขังแล้ว`
        : input.status === 'rejected'
          ? `รายการฝากเงิน ${before.depositNo} ไม่ผ่านการตรวจสอบ`
          : `รายการฝากเงิน ${before.depositNo} อยู่ระหว่างดำเนินการ`,
    body:
      input.status === 'completed'
        ? `เจ้าหน้าที่โอนเข้าบัญชีของ ${before.inmateNameSnapshot} เรียบร้อยแล้ว`
        : (input.reason ?? 'เจ้าหน้าที่กำลังตรวจสอบรายการของคุณ'),
    data: { depositId, depositNo: before.depositNo, status: input.status }
  })

  return depositDetail(depositId, database)
}

/* ── dashboard tile (p.11) ─────────────────────────────────────────────── */

export function depositTotals(
  prisonId: string | null,
  range: { from?: number; to?: number } = {},
  database: Db = defaultDb()
): DepositSummaryTotals {
  const where = and(
    prisonId ? eq(deposits.prisonId, prisonId) : undefined,
    range.from ? gte(deposits.createdAt, range.from) : undefined,
    range.to ? lte(deposits.createdAt, range.to) : undefined
  )

  const rows = database
    .select({
      status: deposits.status,
      n: count(),
      total: sql<number>`coalesce(sum(${deposits.amountSatang}), 0)`
    })
    .from(deposits)
    .where(where)
    .groupBy(deposits.status)
    .all()

  const by = (status: DepositStatus) => rows.find((r) => r.status === status)
  // "Received" is money whose slip has passed, credited or not — the honest
  // number for a facility tile, and the one that reconciles against payments.
  const receivedSatang = (by('reviewing')?.total ?? 0) + (by('completed')?.total ?? 0)

  return {
    from: range.from ?? null,
    to: range.to ?? null,
    buckets: rows.map((r) => ({
      status: r.status,
      count: r.n,
      totalSatang: r.total
    })),
    receivedSatang,
    completedSatang: by('completed')?.total ?? 0,
    pendingCount: by('pending')?.n ?? 0,
    reviewingCount: by('reviewing')?.n ?? 0
  }
}

/** Newest first — used by both the customer history and the admin queue. */
export const depositOrder = [desc(deposits.createdAt), desc(deposits.id)] as const
