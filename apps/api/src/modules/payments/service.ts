import { and, desc, eq, inArray, isNotNull, isNull, lte, or } from 'drizzle-orm'
import {
  THAI_BANKS,
  type CreatePaymentChannelInput,
  type PaymentChannel,
  type PaymentChannelPublic,
  type PaymentPurpose,
  type PaymentView,
  type VerifyPaymentInput
} from '@pc/contract'
import { db as defaultDb, type Db, type DbOrTx } from '../../db/client.js'
import {
  customers,
  orders,
  paymentChannels,
  payments,
  prisons,
  staff,
  type PaymentRail,
  type PaymentState
} from '../../db/schema/index.js'
import { writeAudit } from '../../lib/audit.js'
import { nextPaymentNo } from '../../lib/counters.js'
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js'
import { formatBaht } from '../../lib/money.js'
import { notify } from '../../lib/notify/index.js'
import { storage } from '../../lib/storage/index.js'
import { MINUTE, now } from '../../lib/time.js'
import {
  buildBillPayment,
  buildCreditTransfer,
  normalizeRef,
  parseSlipMiniQr,
  type ProxyType
} from '../../lib/payments/promptpay.js'
import { allocateSalt, chargeIsFree, LIVE_STATES } from '../../lib/payments/salt.js'
import { decodeMiniQr, normalizeSlip, qrDataUrl } from '../../lib/payments/slip.js'
import { normalizeTransRef, transRefTaken, verifierFor } from '../../lib/payments/verifier.js'
import { enqueue } from '../../lib/jobs/queue.js'
import { getSetting } from '../settings/service.js'

export interface PaymentContext {
  ip?: string | null
  userAgent?: string | null
}

type ChannelRow = typeof paymentChannels.$inferSelect
type PaymentRow = typeof payments.$inferSelect

const bankName = (code: string | null) => (code ? (THAI_BANKS[code] ?? null) : null)

/* ── channels ──────────────────────────────────────────────────────────── */

/**
 * §4.3 channel selection: the facility's own channels plus every
 * department-wide one, filtered by purpose, cheapest priority first.
 */
export function channelsFor(
  prisonId: string,
  purpose: PaymentPurpose,
  db: Db = defaultDb()
): ChannelRow[] {
  return db
    .select()
    .from(paymentChannels)
    .where(
      and(
        eq(paymentChannels.isActive, true),
        or(eq(paymentChannels.prisonId, prisonId), isNull(paymentChannels.prisonId))
      )
    )
    .orderBy(paymentChannels.priority, paymentChannels.displayName)
    .all()
    .filter((c) => (c.supportsPurposesJson ?? []).includes(purpose))
}

/** Public projection: no Biller ID, no PromptPay proxy, ever. */
export function toChannelPublic(row: ChannelRow): PaymentChannelPublic {
  return {
    id: row.id,
    rail: row.rail,
    displayName: row.displayName,
    bankCode: row.bankCode,
    bankName: bankName(row.bankCode),
    accountNo: row.rail === 'bank_transfer' ? row.accountNo : null,
    accountName: row.rail === 'bank_transfer' ? row.accountName : null,
    amountSaltEnabled: row.amountSaltEnabled,
    ttlMinutes: row.ttlMinutes,
    note: row.note
  }
}

export function toChannelAdmin(row: ChannelRow, db: Db = defaultDb()): PaymentChannel {
  const prison = row.prisonId
    ? db.select().from(prisons).where(eq(prisons.id, row.prisonId)).get()
    : null
  return {
    ...toChannelPublic(row),
    accountNo: row.accountNo,
    accountName: row.accountName,
    prisonId: row.prisonId,
    prisonName: prison?.nameTh ?? null,
    priority: row.priority,
    isActive: row.isActive,
    billerId: row.billerId,
    terminalSuffix: row.terminalSuffix,
    ref1Mode: row.ref1Mode,
    ref2Mode: row.ref2Mode,
    targetType: row.targetType,
    targetValue: row.targetValue,
    supportsPurposes: row.supportsPurposesJson ?? ['order'],
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

/** Normalised once here so a rail's fields cannot be half-set in the table. */
export function channelValues(input: CreatePaymentChannelInput) {
  const digits = (v?: string | null) => (v ? v.replace(/\D/g, '') : null)
  const biller = digits(input.billerId)
  const suffix = digits(input.terminalSuffix)
  const isBill = input.rail === 'promptpay_bill_payment'
  const isProxy = input.rail === 'promptpay_credit_transfer'

  return {
    prisonId: input.prisonId ?? null,
    rail: input.rail as PaymentRail,
    displayName: input.displayName.trim(),
    priority: input.priority,
    isActive: input.isActive,
    billerId: isBill
      ? biller && biller.length === 15
        ? biller
        : `${biller}${suffix ?? ''}`
      : null,
    terminalSuffix: isBill ? suffix : null,
    ref1Mode: isBill ? input.ref1Mode : 'none',
    ref2Mode: isBill ? input.ref2Mode : 'none',
    targetType: isProxy
      ? input.targetType!
      : input.rail === 'bank_transfer'
        ? 'bank_account'
        : null,
    targetValue: isProxy ? (input.targetValue ?? null) : null,
    bankCode: input.bankCode ?? null,
    accountNo: input.accountNo ?? null,
    accountName: input.accountName ?? null,
    supportsPurposesJson: input.supportsPurposes,
    // tag-30 carries Ref1; salting it would be noise on a reconcilable rail.
    amountSaltEnabled: isBill ? false : input.amountSaltEnabled,
    ttlMinutes: input.ttlMinutes,
    note: input.note ?? null
  }
}

/* ── views ─────────────────────────────────────────────────────────────── */

function orderNoOf(row: PaymentRow, db: DbOrTx): string | null {
  if (row.purpose !== 'order') return null
  return (
    db.select({ orderNo: orders.orderNo }).from(orders).where(eq(orders.id, row.purposeId)).get()
      ?.orderNo ?? null
  )
}

export async function toPaymentView(row: PaymentRow, db: Db = defaultDb()): Promise<PaymentView> {
  const channel = db
    .select()
    .from(paymentChannels)
    .where(eq(paymentChannels.id, row.channelId))
    .get()

  return {
    id: row.id,
    paymentNo: row.paymentNo,
    purpose: row.purpose,
    purposeId: row.purposeId,
    orderNo: orderNoOf(row, db),
    rail: row.rail,
    channelId: row.channelId,
    channelName: channel?.displayName ?? '',
    bankCode: channel?.bankCode ?? null,
    bankName: bankName(channel?.bankCode ?? null),
    accountNo: row.rail === 'bank_transfer' ? (channel?.accountNo ?? null) : null,
    accountName: row.rail === 'bank_transfer' ? (channel?.accountName ?? null) : null,
    amountSatang: row.amountSatang,
    amountSaltSatang: row.amountSaltSatang,
    chargeSatang: row.chargeSatang,
    status: row.status,
    qrPayload: row.qrPayload,
    // Rendered server-side: a front end that builds its own payload is a front
    // end that can get the amount wrong.
    qrImage: row.qrPayload && row.status === 'pending' ? await qrDataUrl(row.qrPayload) : null,
    qrRef1: row.qrRef1,
    qrRef2: row.qrRef2,
    expiresAt: row.expiresAt,
    slipUrl: row.slipImageKey ? `/api/v1/payments/${row.id}/slip` : null,
    slipUploadedAt: row.slipUploadedAt,
    transRef: row.transRef,
    rejectReason: row.rejectReason,
    createdAt: row.createdAt,
    settledAt: row.settledAt
  }
}

const summarySelect = {
  id: payments.id,
  paymentNo: payments.paymentNo,
  purpose: payments.purpose,
  purposeId: payments.purposeId,
  prisonId: payments.prisonId,
  prisonName: prisons.nameTh,
  rail: payments.rail,
  channelId: payments.channelId,
  channelName: paymentChannels.displayName,
  customerId: payments.customerId,
  customerName: customers.fullName,
  customerPhone: customers.phone,
  amountSatang: payments.amountSatang,
  chargeSatang: payments.chargeSatang,
  status: payments.status,
  transRef: payments.transRef,
  slipUploadedAt: payments.slipUploadedAt,
  createdAt: payments.createdAt,
  settledAt: payments.settledAt
}

export function paymentSummaryQuery(db: Db = defaultDb()) {
  return db
    .select(summarySelect)
    .from(payments)
    .innerJoin(paymentChannels, eq(payments.channelId, paymentChannels.id))
    .innerJoin(prisons, eq(payments.prisonId, prisons.id))
    .innerJoin(customers, eq(payments.customerId, customers.id))
}

/** Order numbers for a page of payments — one query, never one per row. */
export function orderNosFor(rows: { purpose: string; purposeId: string }[], db: Db = defaultDb()) {
  const ids = rows.filter((r) => r.purpose === 'order').map((r) => r.purposeId)
  if (ids.length === 0) return new Map<string, string>()
  return new Map(
    db
      .select({ id: orders.id, orderNo: orders.orderNo })
      .from(orders)
      .where(inArray(orders.id, ids))
      .all()
      .map((r) => [r.id, r.orderNo] as const)
  )
}

export function paymentDetail(paymentId: string, db: Db = defaultDb()) {
  const row = db.select().from(payments).where(eq(payments.id, paymentId)).get()
  if (!row) throw notFound('ไม่พบรายการชำระเงิน')

  const channel = db
    .select()
    .from(paymentChannels)
    .where(eq(paymentChannels.id, row.channelId))
    .get()
  const customer = db.select().from(customers).where(eq(customers.id, row.customerId)).get()
  const prison = db.select().from(prisons).where(eq(prisons.id, row.prisonId)).get()
  const verifier = row.verifiedBy
    ? db.select().from(staff).where(eq(staff.id, row.verifiedBy)).get()
    : null

  return {
    row,
    detail: {
      id: row.id,
      paymentNo: row.paymentNo,
      purpose: row.purpose,
      purposeId: row.purposeId,
      orderNo: orderNoOf(row, db),
      prisonId: row.prisonId,
      prisonName: prison?.nameTh ?? null,
      rail: row.rail,
      channelId: row.channelId,
      channelName: channel?.displayName ?? '',
      bankCode: channel?.bankCode ?? null,
      bankName: bankName(channel?.bankCode ?? null),
      accountNo: channel?.accountNo ?? null,
      accountName: channel?.accountName ?? null,
      customerId: row.customerId,
      customerName: customer?.fullName ?? '',
      customerPhone: customer?.phone ?? '',
      amountSatang: row.amountSatang,
      amountSaltSatang: row.amountSaltSatang,
      chargeSatang: row.chargeSatang,
      status: row.status,
      qrRef1: row.qrRef1,
      qrRef2: row.qrRef2,
      expiresAt: row.expiresAt,
      slipUrl: row.slipImageKey ? `/api/v1/admin/payments/${row.id}/slip` : null,
      slipUploadedAt: row.slipUploadedAt,
      transRef: row.transRef,
      sendingBank: row.sendingBank,
      receivingBank: row.receivingBank,
      transferAmountSatang: row.transferAmountSatang,
      transferredAt: row.transferredAt,
      verifiedBy: row.verifiedBy,
      verifiedByName: verifier?.fullName ?? null,
      verifiedAt: row.verifiedAt,
      verifyMethod: row.verifyMethod,
      rejectReason: row.rejectReason,
      slipHint: null as null,
      createdAt: row.createdAt,
      settledAt: row.settledAt
    }
  }
}

/* ── creating a payment ────────────────────────────────────────────────── */

function refValue(
  mode: ChannelRow['ref1Mode'],
  ctx: { paymentNo: string; inmateCode: string | null; phone: string | null }
): string | null {
  switch (mode) {
    case 'payment_no':
      return normalizeRef(ctx.paymentNo)
    case 'inmate_code':
      return ctx.inmateCode ? normalizeRef(ctx.inmateCode) : null
    case 'customer_phone':
      return ctx.phone ? normalizeRef(ctx.phone) : null
    case 'none':
      return null
  }
}

function buildPayload(
  channel: ChannelRow,
  chargeSatang: number,
  refs: { ref1: string | null; ref2: string | null }
): string | null {
  switch (channel.rail) {
    case 'promptpay_bill_payment':
      if (!channel.billerId || !refs.ref1) {
        throw badRequest('ช่องทางชำระบิลนี้ตั้งค่าไม่ครบ กรุณาติดต่อเจ้าหน้าที่')
      }
      return buildBillPayment({
        billerId: channel.billerId,
        ref1: refs.ref1,
        ref2: refs.ref2,
        chargeSatang
      })
    case 'promptpay_credit_transfer':
      if (!channel.targetType || !channel.targetValue || channel.targetType === 'bank_account') {
        throw badRequest('ช่องทางพร้อมเพย์นี้ตั้งค่าไม่ครบ กรุณาติดต่อเจ้าหน้าที่')
      }
      return buildCreditTransfer({
        proxyType: channel.targetType as ProxyType,
        proxyValue: channel.targetValue,
        chargeSatang
      })
    case 'bank_transfer':
      // No QR: the account number on screen is the whole instruction.
      return null
  }
}

/** States an order may be in when a relative asks for a QR. */
const PAYABLE_ORDER_STATES = new Set(['unpaid', 'failed', 'expired'])

export interface CreateOrderPaymentInput {
  channelId?: string
}

/**
 * One live payment per order at a time. Asking again while a QR is still valid
 * returns that same QR rather than burning a second salt — a relative who
 * refreshes the pay screen has not started a second payment.
 */
export async function createOrderPayment(
  customerId: string,
  orderId: string,
  input: CreateOrderPaymentInput,
  ctx: PaymentContext = {},
  database: Db = defaultDb()
): Promise<PaymentView> {
  const at = now()

  const order = database.select().from(orders).where(eq(orders.id, orderId)).get()
  if (!order) throw notFound('ไม่พบคำสั่งซื้อ')
  if (order.customerId !== customerId) throw forbidden('ไม่มีสิทธิ์เข้าถึงคำสั่งซื้อนี้')
  if (order.fulfillmentStatus === 'cancelled') throw conflict('คำสั่งซื้อนี้ถูกยกเลิกแล้ว')
  if (!PAYABLE_ORDER_STATES.has(order.paymentStatus)) {
    throw conflict(
      order.paymentStatus === 'awaiting_verify'
        ? 'มีสลิปที่รอเจ้าหน้าที่ตรวจสอบอยู่แล้ว'
        : 'คำสั่งซื้อนี้ชำระเงินเรียบร้อยแล้ว'
    )
  }
  if (order.totalSatang <= 0) throw badRequest('ยอดชำระต้องมากกว่า 0')

  const available = channelsFor(order.prisonId, 'order', database)
  if (available.length === 0) throw conflict('เรือนจำนี้ยังไม่ได้เปิดช่องทางชำระเงิน')

  const channel = input.channelId
    ? available.find((c) => c.id === input.channelId)
    : (available.find(
        (c) =>
          c.id ===
          getSetting('payment.channel_default', {
            prisonId: order.prisonId,
            db: database
          })
      ) ?? available[0])
  if (!channel) throw notFound('ไม่พบช่องทางชำระเงินที่เลือก')

  const existing = database
    .select()
    .from(payments)
    .where(
      and(
        eq(payments.purpose, 'order'),
        eq(payments.purposeId, orderId),
        inArray(payments.status, [...LIVE_STATES])
      )
    )
    .orderBy(desc(payments.createdAt))
    .get()

  if (existing) {
    const stillValid = (existing.expiresAt ?? Infinity) > at
    if (existing.channelId === channel.id && stillValid) {
      return toPaymentView(existing, database)
    }
    // Switching rails, or the old QR lapsed: retire it so its salt goes back
    // to the pool before a new one is allocated.
    database
      .update(payments)
      .set({ status: 'expired', updatedAt: at })
      .where(eq(payments.id, existing.id))
      .run()
  }

  const customer = database.select().from(customers).where(eq(customers.id, customerId)).get()
  const prison = database.select().from(prisons).where(eq(prisons.id, order.prisonId)).get()
  if (!prison) throw notFound('ไม่พบเรือนจำ')

  const ttl = channel.ttlMinutes || getSetting('payment.qr.ttl_minutes', { db: database })
  const saltingOn =
    channel.amountSaltEnabled && getSetting('payment.salt.enabled', { db: database })

  // BEGIN IMMEDIATE: the salt is only unique for as long as nothing else
  // writes, so allocation and insert are one transaction (§4.3).
  const paymentId = database.transaction(
    (tx) => {
      const salt = saltingOn ? allocateSalt(channel.id, order.totalSatang, tx) : 0
      const charge = order.totalSatang + salt
      if (
        !saltingOn &&
        !chargeIsFree(channel.id, charge, tx) &&
        channel.rail !== 'promptpay_bill_payment'
      ) {
        // Unsalted tag-29/bank transfer: two identical live amounts on one
        // account are genuinely unreconcilable, so refuse rather than guess.
        throw conflict('มีรายการรอชำระยอดเดียวกันอยู่ กรุณาลองใหม่ในอีกสักครู่')
      }

      const paymentNo = nextPaymentNo(prison.id, prison.code, tx, at)
      const refCtx = {
        paymentNo,
        inmateCode: order.inmateCodeSnapshot,
        phone: customer?.phone ?? null
      }
      const ref1 = refValue(channel.ref1Mode, refCtx)
      const ref2 = refValue(channel.ref2Mode, refCtx)
      const payload = buildPayload(channel, charge, { ref1, ref2 })

      return tx
        .insert(payments)
        .values({
          paymentNo,
          purpose: 'order',
          purposeId: orderId,
          channelId: channel.id,
          rail: channel.rail,
          customerId,
          prisonId: order.prisonId,
          amountSatang: order.totalSatang,
          amountSaltSatang: salt,
          chargeSatang: charge,
          status: 'pending',
          qrPayload: payload,
          qrRef1: ref1,
          qrRef2: ref2,
          expiresAt: at + ttl * MINUTE,
          createdAt: at,
          updatedAt: at
        })
        .returning({ id: payments.id })
        .get().id
    },
    { behavior: 'immediate' }
  )

  const row = database.select().from(payments).where(eq(payments.id, paymentId)).get()!
  enqueue('payment.expire', { paymentId }, { runAt: (row.expiresAt ?? at) + MINUTE, db: database })

  writeAudit(
    {
      actorType: 'customer',
      actorId: customerId,
      action: 'payment.created',
      entity: 'payment',
      entityId: paymentId,
      prisonId: order.prisonId,
      after: {
        paymentNo: row.paymentNo,
        orderId,
        rail: row.rail,
        chargeSatang: row.chargeSatang,
        saltSatang: row.amountSaltSatang
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )

  return toPaymentView(row, database)
}

/* ── slip upload ───────────────────────────────────────────────────────── */

export interface SlipHint {
  transRef: string | null
  sendingBank: string | null
  decoded: boolean
}

/** better-sqlite3 surfaces a UNIQUE violation as a message, not a code field. */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message)
}

/**
 * The relative uploads a photograph; the mini-QR is read as a convenience and
 * the reference it yields is claimed immediately. Claiming it here is what
 * stops one slip from being queued against two payments (§4.3 rule 1) — the
 * UNIQUE index does the enforcing, this code only makes the failure readable.
 */
export async function uploadSlip(
  customerId: string,
  paymentId: string,
  file: { buffer: Buffer; contentType?: string; filename?: string },
  ctx: PaymentContext = {},
  database: Db = defaultDb()
): Promise<{ payment: PaymentView; hint: SlipHint }> {
  const at = now()
  const row = database.select().from(payments).where(eq(payments.id, paymentId)).get()
  if (!row) throw notFound('ไม่พบรายการชำระเงิน')
  if (row.customerId !== customerId) throw forbidden('ไม่มีสิทธิ์เข้าถึงรายการชำระเงินนี้')
  if (row.status === 'succeeded') throw conflict('รายการนี้ชำระเงินเรียบร้อยแล้ว')
  if (row.status === 'expired') throw conflict('รายการชำระเงินนี้หมดอายุแล้ว กรุณาสร้าง QR ใหม่')
  if (row.status === 'refunded') throw conflict('รายการนี้คืนเงินไปแล้ว')

  const normalized = await normalizeSlip(file.buffer, file.contentType)
  const decoded = await decodeMiniQr(normalized.buffer)
  const mini = decoded ? parseSlipMiniQr(decoded) : null
  const transRef = mini?.transRef ? normalizeTransRef(mini.transRef) : null

  if (transRef && transRefTaken(transRef, paymentId, database)) {
    throw conflict('สลิปนี้ถูกใช้ยืนยันการชำระเงินรายการอื่นไปแล้ว')
  }

  const stored = await storage().put(normalized.buffer, {
    contentType: normalized.contentType,
    prefix: 'slips',
    filename: 'slip.jpg'
  })

  const previousKey = row.slipImageKey
  try {
    database
      .update(payments)
      .set({
        slipImageKey: stored.key,
        slipUploadedAt: at,
        status: 'awaiting_verify' satisfies PaymentState,
        transRef: transRef ?? row.transRef,
        sendingBank: mini?.sendingBank ?? row.sendingBank,
        rejectReason: null,
        updatedAt: at
      })
      .where(eq(payments.id, paymentId))
      .run()
  } catch (err) {
    await storage().delete(stored.key)
    if (isUniqueViolation(err)) throw conflict('สลิปนี้ถูกใช้ยืนยันการชำระเงินรายการอื่นไปแล้ว')
    throw err
  }
  // A replaced slip is deleted, not orphaned — PDPA retention counts images.
  if (previousKey && previousKey !== stored.key) await storage().delete(previousKey)

  if (row.purpose === 'order') {
    database
      .update(orders)
      .set({ paymentStatus: 'awaiting_verify', updatedAt: at })
      .where(eq(orders.id, row.purposeId))
      .run()
  }

  writeAudit(
    {
      actorType: 'customer',
      actorId: customerId,
      action: 'payment.slip_uploaded',
      entity: 'payment',
      entityId: paymentId,
      prisonId: row.prisonId,
      after: { transRef, decoded: !!decoded, bytes: normalized.bytes },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )

  const after = database.select().from(payments).where(eq(payments.id, paymentId)).get()!
  return {
    payment: await toPaymentView(after, database),
    hint: { transRef, sendingBank: mini?.sendingBank ?? null, decoded: !!decoded }
  }
}

export async function readSlip(row: PaymentRow): Promise<Buffer> {
  if (!row.slipImageKey) throw notFound('ยังไม่มีสลิปสำหรับรายการนี้')
  return storage().get(row.slipImageKey)
}

/* ── verification ──────────────────────────────────────────────────────── */

function verifyOptions(prisonId: string, database: Db) {
  return {
    graceMinutes: getSetting('payment.slip.grace_minutes', { prisonId, db: database }),
    requireBankMatch: getSetting('payment.slip.require_bank_match', { prisonId, db: database })
  }
}

export async function verifyPayment(
  staffId: string,
  paymentId: string,
  input: VerifyPaymentInput,
  ctx: PaymentContext = {},
  database: Db = defaultDb()
) {
  const at = now()
  const row = database.select().from(payments).where(eq(payments.id, paymentId)).get()
  if (!row) throw notFound('ไม่พบรายการชำระเงิน')
  if (row.status === 'succeeded') throw conflict('รายการนี้ยืนยันไปแล้ว')
  if (row.status !== 'awaiting_verify') {
    throw conflict('ยืนยันได้เฉพาะรายการที่มีสลิปรอตรวจสอบเท่านั้น')
  }

  const verifier = verifierFor('manual')
  const outcome = verifier.check(
    {
      id: row.id,
      rail: row.rail,
      chargeSatang: row.chargeSatang,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
      channelBankCode: null,
      channelAccountNo: null
    },
    { ...input, transRef: input.transRef },
    verifyOptions(row.prisonId, database),
    database
  )
  if (!outcome.ok) throw conflict(outcome.failures.join(' • '))

  const transRef = normalizeTransRef(input.transRef)
  try {
    database
      .update(payments)
      .set({
        status: 'succeeded' satisfies PaymentState,
        transRef,
        sendingBank: input.sendingBank ?? row.sendingBank,
        receivingBank: input.receivingBank ?? row.receivingBank,
        transferAmountSatang: input.transferAmountSatang,
        transferredAt: input.transferredAt,
        verifiedBy: staffId,
        verifiedAt: at,
        verifyMethod: verifier.method,
        rejectReason: null,
        settledAt: at,
        updatedAt: at
      })
      .where(eq(payments.id, paymentId))
      .run()
  } catch (err) {
    if (isUniqueViolation(err)) throw conflict('สลิปนี้ถูกใช้ยืนยันการชำระเงินรายการอื่นไปแล้ว')
    throw err
  }

  if (row.purpose === 'order') {
    database
      .update(orders)
      .set({ paymentStatus: 'paid', paidAt: at, updatedBy: staffId, updatedAt: at })
      .where(eq(orders.id, row.purposeId))
      .run()
  }

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'payment.verified',
      entity: 'payment',
      entityId: paymentId,
      prisonId: row.prisonId,
      before: { status: row.status },
      after: { status: 'succeeded', transRef, transferAmountSatang: input.transferAmountSatang },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )

  const orderNo = orderNoOf(row, database)
  await notify({
    audience: 'customer',
    recipientId: row.customerId,
    kind: 'payment.verified',
    title: `ยืนยันการชำระเงิน ${formatBaht(row.chargeSatang)} แล้ว`,
    body: orderNo
      ? `เจ้าหน้าที่ตรวจสอบสลิปของคำสั่งซื้อ ${orderNo} เรียบร้อยแล้ว`
      : 'เจ้าหน้าที่ตรวจสอบสลิปของคุณเรียบร้อยแล้ว',
    data: { paymentId, paymentNo: row.paymentNo, orderId: row.purposeId }
  })

  return paymentDetail(paymentId, database).detail
}

export async function rejectPayment(
  staffId: string,
  paymentId: string,
  reason: string,
  ctx: PaymentContext = {},
  database: Db = defaultDb()
) {
  const at = now()
  const row = database.select().from(payments).where(eq(payments.id, paymentId)).get()
  if (!row) throw notFound('ไม่พบรายการชำระเงิน')
  if (row.status !== 'awaiting_verify') {
    throw conflict('ปฏิเสธได้เฉพาะรายการที่มีสลิปรอตรวจสอบเท่านั้น')
  }

  database
    .update(payments)
    .set({
      status: 'failed' satisfies PaymentState,
      rejectReason: reason.trim(),
      verifiedBy: staffId,
      verifiedAt: at,
      verifyMethod: 'manual',
      updatedAt: at
    })
    .where(eq(payments.id, paymentId))
    .run()

  // The order goes back to unpaid, not failed: the relative can pay again, and
  // the rejected payment row keeps the record of why the first attempt died.
  if (row.purpose === 'order') {
    database
      .update(orders)
      .set({ paymentStatus: 'unpaid', updatedBy: staffId, updatedAt: at })
      .where(eq(orders.id, row.purposeId))
      .run()
  }

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'payment.rejected',
      entity: 'payment',
      entityId: paymentId,
      prisonId: row.prisonId,
      before: { status: row.status },
      after: { status: 'failed', reason },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )

  await notify({
    audience: 'customer',
    recipientId: row.customerId,
    kind: 'payment.rejected',
    title: `สลิปของรายการ ${row.paymentNo} ไม่ผ่านการตรวจสอบ`,
    body: reason,
    data: { paymentId, paymentNo: row.paymentNo, orderId: row.purposeId }
  })

  return paymentDetail(paymentId, database).detail
}

/**
 * Refund is a bookkeeping state, not a transfer: the money goes back through
 * whatever channel finance uses. Recording it here is what lets a paid order
 * be cancelled without leaving a hole in the ledger.
 */
export async function refundPayment(
  staffId: string,
  paymentId: string,
  reason: string,
  ctx: PaymentContext = {},
  database: Db = defaultDb()
) {
  const at = now()
  const row = database.select().from(payments).where(eq(payments.id, paymentId)).get()
  if (!row) throw notFound('ไม่พบรายการชำระเงิน')
  if (row.status !== 'succeeded') throw conflict('คืนเงินได้เฉพาะรายการที่ชำระสำเร็จแล้ว')

  database
    .update(payments)
    .set({
      status: 'refunded' satisfies PaymentState,
      rejectReason: reason.trim(),
      updatedAt: at
    })
    .where(eq(payments.id, paymentId))
    .run()

  if (row.purpose === 'order') {
    database
      .update(orders)
      .set({ paymentStatus: 'refunded', updatedBy: staffId, updatedAt: at })
      .where(eq(orders.id, row.purposeId))
      .run()
  }

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'payment.refunded',
      entity: 'payment',
      entityId: paymentId,
      prisonId: row.prisonId,
      before: { status: row.status },
      after: { status: 'refunded', reason },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )

  return paymentDetail(paymentId, database).detail
}

/* ── expiry ────────────────────────────────────────────────────────────── */

/**
 * `pending` only. A payment with a slip on it is waiting on staff, not on the
 * relative, and expiring it would discard evidence.
 */
export function expireDuePayments(at = now(), database: Db = defaultDb()): number {
  const res = database
    .update(payments)
    .set({ status: 'expired' satisfies PaymentState, updatedAt: at })
    .where(
      and(
        eq(payments.status, 'pending'),
        isNotNull(payments.expiresAt),
        lte(payments.expiresAt, at)
      )
    )
    .run()
  return res.changes
}

/** Called when an order is cancelled — an unpaid QR must stop being payable. */
export function voidLivePaymentsForOrder(orderId: string, database: Db = defaultDb()): number {
  return database
    .update(payments)
    .set({ status: 'expired' satisfies PaymentState, updatedAt: now() })
    .where(
      and(
        eq(payments.purpose, 'order'),
        eq(payments.purposeId, orderId),
        eq(payments.status, 'pending')
      )
    )
    .run().changes
}

/** Every payment attached to one order, newest first. */
export function paymentsForOrder(orderId: string, database: Db = defaultDb()) {
  return database
    .select()
    .from(payments)
    .where(and(eq(payments.purpose, 'order'), eq(payments.purposeId, orderId)))
    .orderBy(desc(payments.createdAt))
    .all()
}
