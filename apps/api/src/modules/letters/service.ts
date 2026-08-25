import { and, count, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type {
  CreateLetterBatchInput,
  CreateLetterInput,
  CreateLetterPackageInput,
  LetterBatch,
  LetterDetail,
  LetterDirection,
  LetterPackage,
  LetterPurchaseDetail,
  LetterStatus,
  LetterSummaryTotals,
  ScanReplyResult,
  UpdateLetterPackageInput,
  UpdateLetterStatusInput
} from '@pc/contract'
import { db as defaultDb, type Db, type DbOrTx } from '../../db/client.js'
import {
  customerInmates,
  customers,
  inmates,
  letterAttachments,
  letterBatches,
  letterCreditLedger,
  letterPackages,
  letterPurchases,
  letters,
  payments,
  prisons,
  staff,
  zones
} from '../../db/schema/index.js'
import { writeAudit } from '../../lib/audit.js'
import { nextLetterBatchNo, nextLetterNo, nextLetterPurchaseNo } from '../../lib/counters.js'
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js'
import { enqueue } from '../../lib/jobs/queue.js'
import { decodeReplyQr, normalizeLetterImage } from '../../lib/letters/image.js'
import { letterRenderer } from '../../lib/letters/render.js'
import { renderBatchHtml, type LetterSheet } from '../../lib/letters/template.js'
import { notify } from '../../lib/notify/index.js'
import { storage } from '../../lib/storage/index.js'
import { now } from '../../lib/time.js'
import { getSetting } from '../settings/service.js'
import { creditBalance, moveCredits } from './credits.js'
import { createPaymentFor, livePaymentFor, toPaymentView } from '../payments/service.js'

export interface LetterContext {
  ip?: string | null
  userAgent?: string | null
}

/* ── packages ──────────────────────────────────────────────────────────── */

const packageSelect = {
  id: letterPackages.id,
  prisonId: letterPackages.prisonId,
  prisonName: prisons.nameTh,
  name: letterPackages.name,
  direction: letterPackages.direction,
  priceSatang: letterPackages.priceSatang,
  quota: letterPackages.quota,
  isActive: letterPackages.isActive,
  sortOrder: letterPackages.sortOrder,
  note: letterPackages.note
}

export function letterPackageQuery(db: Db = defaultDb()) {
  return db
    .select(packageSelect)
    .from(letterPackages)
    .leftJoin(prisons, eq(letterPackages.prisonId, prisons.id))
}

/**
 * What a facility offers: its own packages plus the department-wide ones,
 * exactly like a payment channel. Cheapest-sorting first.
 */
export function packagesFor(
  prisonId: string | null,
  opts: { includeInactive?: boolean; direction?: LetterDirection } = {},
  db: Db = defaultDb()
): LetterPackage[] {
  return letterPackageQuery(db)
    .where(
      and(
        prisonId
          ? or(eq(letterPackages.prisonId, prisonId), isNull(letterPackages.prisonId))
          : undefined,
        opts.includeInactive ? undefined : eq(letterPackages.isActive, true),
        opts.direction ? eq(letterPackages.direction, opts.direction) : undefined
      )
    )
    .orderBy(letterPackages.sortOrder, letterPackages.priceSatang)
    .all()
}

export function letterPackageView(id: string, db: Db = defaultDb()): LetterPackage {
  const row = letterPackageQuery(db).where(eq(letterPackages.id, id)).get()
  if (!row) throw notFound('ไม่พบแพ็กเกจจดหมาย')
  return row
}

export function createLetterPackage(
  staffId: string,
  input: CreateLetterPackageInput,
  db: Db = defaultDb()
): LetterPackage {
  const row = db
    .insert(letterPackages)
    .values({
      prisonId: input.prisonId ?? null,
      name: input.name,
      direction: input.direction,
      priceSatang: input.priceSatang,
      quota: input.quota,
      isActive: input.isActive ?? true,
      sortOrder: input.sortOrder ?? 100,
      note: input.note ?? null,
      createdBy: staffId,
      updatedBy: staffId
    })
    .returning()
    .get()

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'letter_package.created',
      entity: 'letter_package',
      entityId: row.id,
      prisonId: row.prisonId,
      after: input
    },
    db
  )
  return letterPackageView(row.id, db)
}

export function updateLetterPackage(
  staffId: string,
  id: string,
  input: UpdateLetterPackageInput,
  db: Db = defaultDb()
): LetterPackage {
  const before = db.select().from(letterPackages).where(eq(letterPackages.id, id)).get()
  if (!before) throw notFound('ไม่พบแพ็กเกจจดหมาย')

  db.update(letterPackages)
    .set({
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.direction !== undefined ? { direction: input.direction } : {}),
      ...(input.priceSatang !== undefined ? { priceSatang: input.priceSatang } : {}),
      ...(input.quota !== undefined ? { quota: input.quota } : {}),
      ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
      ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      ...(input.note !== undefined ? { note: input.note ?? null } : {}),
      updatedBy: staffId,
      updatedAt: now()
    })
    .where(eq(letterPackages.id, id))
    .run()

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'letter_package.updated',
      entity: 'letter_package',
      entityId: id,
      prisonId: before.prisonId,
      before: { name: before.name, priceSatang: before.priceSatang, quota: before.quota },
      after: input
    },
    db
  )
  return letterPackageView(id, db)
}

/* ── package purchases — the third purpose on the payment spine ────────── */

const purchaseSelect = {
  id: letterPurchases.id,
  purchaseNo: letterPurchases.purchaseNo,
  status: letterPurchases.status,
  packageId: letterPurchases.packageId,
  packageName: letterPurchases.packageNameSnapshot,
  direction: letterPurchases.direction,
  quota: letterPurchases.quota,
  priceSatang: letterPurchases.priceSatang,
  customerId: letterPurchases.customerId,
  customerName: customers.fullName,
  customerPhone: customers.phone,
  prisonId: letterPurchases.prisonId,
  prisonName: prisons.nameTh,
  createdAt: letterPurchases.createdAt,
  paidAt: letterPurchases.paidAt
}

export function letterPurchaseQuery(db: Db = defaultDb()) {
  return db
    .select(purchaseSelect)
    .from(letterPurchases)
    .innerJoin(customers, eq(letterPurchases.customerId, customers.id))
    .innerJoin(prisons, eq(letterPurchases.prisonId, prisons.id))
}

/** Payment statuses for a page of purchases — one query, never one per row. */
export function purchasePaymentStatuses(rows: { id: string }[], db: Db = defaultDb()) {
  const ids = rows.map((r) => r.id)
  if (ids.length === 0) return new Map<string, string>()
  return new Map(
    db
      .select({ id: letterPurchases.id, status: payments.status })
      .from(letterPurchases)
      .innerJoin(payments, eq(payments.id, letterPurchases.paymentId))
      .where(inArray(letterPurchases.id, ids))
      .all()
      .map((r) => [r.id, r.status] as const)
  )
}

export async function letterPurchaseDetail(
  purchaseId: string,
  db: Db = defaultDb()
): Promise<LetterPurchaseDetail> {
  const summary = letterPurchaseQuery(db).where(eq(letterPurchases.id, purchaseId)).get()
  if (!summary) throw notFound('ไม่พบรายการซื้อแพ็กเกจจดหมาย')
  const payment = livePaymentFor('letter_package', purchaseId, db)
  return {
    ...summary,
    paymentStatus: payment?.status ?? null,
    payment: payment ? await toPaymentView(payment, db) : null
  }
}

/** Which prison a relative's letter business belongs to: the verified link's. */
function homePrison(customerId: string, requested: string | null, database: Db): string {
  const links = database
    .select({ prisonId: inmates.prisonId })
    .from(customerInmates)
    .innerJoin(inmates, eq(customerInmates.inmateId, inmates.id))
    .where(
      and(eq(customerInmates.customerId, customerId), eq(customerInmates.verifyStatus, 'verified'))
    )
    .all()
  if (links.length === 0) {
    throw forbidden('คำขอผูกบัญชีกับผู้ต้องขังยังไม่ได้รับการยืนยันจากเจ้าหน้าที่')
  }
  if (requested) {
    if (!links.some((l) => l.prisonId === requested)) {
      throw forbidden('ไม่มีผู้ต้องขังที่ยืนยันแล้วในเรือนจำนี้')
    }
    return requested
  }
  return links[0]!.prisonId
}

export async function purchasePackage(
  customerId: string,
  packageId: string,
  input: { prisonId?: string; channelId?: string } = {},
  ctx: LetterContext = {},
  database: Db = defaultDb()
): Promise<LetterPurchaseDetail> {
  const at = now()
  const pkg = database.select().from(letterPackages).where(eq(letterPackages.id, packageId)).get()
  if (!pkg) throw notFound('ไม่พบแพ็กเกจจดหมาย')
  if (!pkg.isActive) throw conflict('แพ็กเกจนี้ปิดการขายแล้ว')

  const prisonId = homePrison(customerId, input.prisonId ?? pkg.prisonId ?? null, database)
  if (pkg.prisonId && pkg.prisonId !== prisonId) {
    throw forbidden('แพ็กเกจนี้เป็นของเรือนจำอื่น')
  }
  const prison = database.select().from(prisons).where(eq(prisons.id, prisonId)).get()
  if (!prison) throw notFound('ไม่พบเรือนจำ')

  const purchaseId = database.transaction(
    (tx) => {
      const purchaseNo = nextLetterPurchaseNo(prison.id, prison.code, tx, at)
      return tx
        .insert(letterPurchases)
        .values({
          purchaseNo,
          customerId,
          packageId: pkg.id,
          prisonId: prison.id,
          packageNameSnapshot: pkg.name,
          direction: pkg.direction,
          quota: pkg.quota,
          priceSatang: pkg.priceSatang,
          status: 'pending',
          createdAt: at,
          updatedAt: at
        })
        .returning({ id: letterPurchases.id })
        .get().id
    },
    { behavior: 'immediate' }
  )

  const payment = await createPaymentFor(
    {
      purpose: 'letter_package',
      purposeId: purchaseId,
      customerId,
      prisonId: prison.id,
      amountSatang: pkg.priceSatang,
      inmateCode: null,
      channelId: input.channelId,
      action: 'letter_package.payment_created'
    },
    ctx,
    database
  )
  database
    .update(letterPurchases)
    .set({ paymentId: payment.id, updatedAt: now() })
    .where(eq(letterPurchases.id, purchaseId))
    .run()

  writeAudit(
    {
      actorType: 'customer',
      actorId: customerId,
      action: 'letter_package.purchased',
      entity: 'letter_purchase',
      entityId: purchaseId,
      prisonId: prison.id,
      after: { packageId: pkg.id, quota: pkg.quota, paymentNo: payment.paymentNo },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )
  return letterPurchaseDetail(purchaseId, database)
}

/** A fresh QR for an existing purchase — never a second purchase. */
export async function createPurchasePayment(
  customerId: string,
  purchaseId: string,
  input: { channelId?: string } = {},
  ctx: LetterContext = {},
  database: Db = defaultDb()
): Promise<LetterPurchaseDetail> {
  const row = database
    .select()
    .from(letterPurchases)
    .where(eq(letterPurchases.id, purchaseId))
    .get()
  if (!row) throw notFound('ไม่พบรายการซื้อแพ็กเกจจดหมาย')
  if (row.customerId !== customerId) throw forbidden('ไม่มีสิทธิ์เข้าถึงรายการนี้')
  if (row.status !== 'pending') throw conflict('รายการนี้ไม่อยู่ในสถานะที่ต้องชำระเงินแล้ว')

  const payment = await createPaymentFor(
    {
      purpose: 'letter_package',
      purposeId: purchaseId,
      customerId,
      prisonId: row.prisonId,
      amountSatang: row.priceSatang,
      inmateCode: null,
      channelId: input.channelId,
      action: 'letter_package.payment_created'
    },
    ctx,
    database
  )
  database
    .update(letterPurchases)
    .set({ paymentId: payment.id, updatedAt: now() })
    .where(eq(letterPurchases.id, purchaseId))
    .run()

  return letterPurchaseDetail(purchaseId, database)
}

/* ── letters ───────────────────────────────────────────────────────────── */

const letterSelect = {
  id: letters.id,
  letterNo: letters.letterNo,
  direction: letters.direction,
  status: letters.status,
  customerId: sql<
    string | null
  >`coalesce(${letters.senderCustomerId}, ${letters.recipientCustomerId})`,
  customerName: letters.customerNameSnapshot,
  inmateId: sql<string | null>`coalesce(${letters.recipientInmateId}, ${letters.senderInmateId})`,
  inmateCode: letters.inmateCodeSnapshot,
  inmateName: letters.inmateNameSnapshot,
  prisonId: letters.prisonId,
  prisonName: prisons.nameTh,
  zoneId: letters.zoneId,
  zoneName: letters.zoneNameSnapshot,
  preview: sql<string>`substr(${letters.bodyText}, 1, 90)`,
  attachmentCount: letters.attachmentCount,
  batchId: letters.batchId,
  batchNo: letterBatches.batchNo,
  replyToLetterId: letters.replyToLetterId,
  createdAt: letters.createdAt,
  queuedAt: letters.queuedAt,
  printedAt: letters.printedAt,
  dispatchedAt: letters.dispatchedAt,
  deliveredAt: letters.deliveredAt
}

export function letterQuery(db: Db = defaultDb()) {
  return db
    .select(letterSelect)
    .from(letters)
    .innerJoin(prisons, eq(letters.prisonId, prisons.id))
    .leftJoin(letterBatches, eq(letters.batchId, letterBatches.id))
}

/** Reply numbers and reply-existence for a page of letters, in two queries. */
export function replyInfoFor(
  rows: { id: string; replyToLetterId: string | null }[],
  db: Db = defaultDb()
) {
  const ids = rows.map((r) => r.id)
  const parentIds = rows.map((r) => r.replyToLetterId).filter((v): v is string => !!v)

  const replied = new Set(
    ids.length === 0
      ? []
      : db
          .select({ parent: letters.replyToLetterId })
          .from(letters)
          .where(inArray(letters.replyToLetterId, ids))
          .all()
          .map((r) => r.parent!)
  )
  const parentNos = new Map(
    parentIds.length === 0
      ? []
      : db
          .select({ id: letters.id, letterNo: letters.letterNo })
          .from(letters)
          .where(inArray(letters.id, parentIds))
          .all()
          .map((r) => [r.id, r.letterNo] as const)
  )
  return {
    decorate: <T extends { id: string; replyToLetterId: string | null }>(row: T) => ({
      ...row,
      hasReply: replied.has(row.id),
      replyToLetterNo: row.replyToLetterId ? (parentNos.get(row.replyToLetterId) ?? null) : null
    })
  }
}

export function attachmentsOf(letterId: string, db: Db = defaultDb()) {
  return db
    .select()
    .from(letterAttachments)
    .where(eq(letterAttachments.letterId, letterId))
    .orderBy(letterAttachments.sortOrder, letterAttachments.createdAt)
    .all()
    .map((a) => ({
      id: a.id,
      letterId: a.letterId,
      sortOrder: a.sortOrder,
      url: `/api/v1/letters/${a.letterId}/attachments/${a.id}`,
      createdAt: a.createdAt
    }))
}

export function letterDetail(letterId: string, db: Db = defaultDb()): LetterDetail {
  const summary = letterQuery(db).where(eq(letters.id, letterId)).get()
  if (!summary) throw notFound('ไม่พบจดหมาย')
  const row = db.select().from(letters).where(eq(letters.id, letterId)).get()!
  const printer = row.printedBy
    ? db.select().from(staff).where(eq(staff.id, row.printedBy)).get()
    : null

  return {
    ...replyInfoFor([summary], db).decorate(summary),
    bodyText: row.bodyText,
    rejectedReason: row.rejectedReason,
    scanUrl: row.scanImageKey ? `/api/v1/letters/${row.id}/scan` : null,
    attachments: attachmentsOf(letterId, db),
    printedByName: printer?.fullName ?? null
  }
}

/** Money and letters never move against an unverified link (§4.1b). */
function assertMayWrite(customerId: string, inmateId: string, database: Db) {
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

export function createLetter(
  customerId: string,
  input: CreateLetterInput,
  ctx: LetterContext = {},
  database: Db = defaultDb()
): LetterDetail {
  const at = now()
  const inmate = assertMayWrite(customerId, input.inmateId, database)
  const prison = database.select().from(prisons).where(eq(prisons.id, inmate.prisonId)).get()
  if (!prison) throw notFound('ไม่พบเรือนจำ')
  assertBodyLength(input.bodyText ?? '', prison.id, database)

  const zone = inmate.zoneId
    ? database.select().from(zones).where(eq(zones.id, inmate.zoneId)).get()
    : null
  const customer = database.select().from(customers).where(eq(customers.id, customerId)).get()

  // The number is allocated up front: it is printed on the sheet and encoded
  // in the reply QR, so it has to exist before anything is composed against it.
  const letterId = database.transaction(
    (tx) => {
      const letterNo = nextLetterNo(prison.id, prison.code, tx, at)
      return tx
        .insert(letters)
        .values({
          letterNo,
          direction: 'to_prison',
          senderCustomerId: customerId,
          recipientInmateId: inmate.id,
          prisonId: prison.id,
          zoneId: inmate.zoneId,
          zoneNameSnapshot: zone?.name ?? null,
          inmateCodeSnapshot: inmate.inmateCode,
          inmateNameSnapshot: inmate.fullName,
          customerNameSnapshot: customer?.fullName ?? null,
          bodyText: input.bodyText ?? '',
          status: 'draft',
          createdAt: at,
          updatedAt: at
        })
        .returning({ id: letters.id })
        .get().id
    },
    { behavior: 'immediate' }
  )

  writeAudit(
    {
      actorType: 'customer',
      actorId: customerId,
      action: 'letter.drafted',
      entity: 'letter',
      entityId: letterId,
      prisonId: prison.id,
      after: { inmateId: inmate.id },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )
  return letterDetail(letterId, database)
}

function assertBodyLength(body: string, prisonId: string, database: Db) {
  const max = getSetting('letter.max_chars', { prisonId, db: database })
  if (body.length > max) throw badRequest(`เนื้อหาจดหมายยาวเกิน ${max} ตัวอักษร`)
}

function ownDraft(customerId: string, letterId: string, database: Db) {
  const row = database.select().from(letters).where(eq(letters.id, letterId)).get()
  if (!row) throw notFound('ไม่พบจดหมาย')
  if (row.senderCustomerId !== customerId) throw forbidden('ไม่มีสิทธิ์เข้าถึงจดหมายฉบับนี้')
  if (row.status !== 'draft') throw conflict('จดหมายฉบับนี้ส่งเข้าคิวแล้ว แก้ไขไม่ได้')
  return row
}

export function updateLetter(
  customerId: string,
  letterId: string,
  bodyText: string,
  database: Db = defaultDb()
): LetterDetail {
  const row = ownDraft(customerId, letterId, database)
  assertBodyLength(bodyText, row.prisonId, database)
  database.update(letters).set({ bodyText, updatedAt: now() }).where(eq(letters.id, letterId)).run()
  return letterDetail(letterId, database)
}

export async function addAttachment(
  customerId: string,
  letterId: string,
  file: { buffer: Buffer; contentType?: string; filename?: string },
  database: Db = defaultDb()
): Promise<LetterDetail> {
  const row = ownDraft(customerId, letterId, database)
  const max = getSetting('letter.max_attachments', { prisonId: row.prisonId, db: database })
  if (max === 0) throw conflict('เรือนจำนี้ไม่รับรูปแนบ')
  if (row.attachmentCount >= max) throw conflict(`แนบรูปได้ไม่เกิน ${max} รูปต่อฉบับ`)

  const image = await normalizeLetterImage(file.buffer, {
    declaredType: file.contentType,
    label: 'รูปแนบ'
  })
  const stored = await storage().put(image.buffer, {
    prefix: 'letters/attachments',
    contentType: image.contentType,
    filename: 'photo.jpg'
  })

  const at = now()
  database
    .insert(letterAttachments)
    .values({
      letterId,
      imageKey: stored.key,
      sortOrder: row.attachmentCount,
      createdAt: at
    })
    .run()
  database
    .update(letters)
    .set({ attachmentCount: row.attachmentCount + 1, updatedAt: at })
    .where(eq(letters.id, letterId))
    .run()

  return letterDetail(letterId, database)
}

export async function removeAttachment(
  customerId: string,
  letterId: string,
  attachmentId: string,
  database: Db = defaultDb()
): Promise<LetterDetail> {
  const row = ownDraft(customerId, letterId, database)
  const att = database
    .select()
    .from(letterAttachments)
    .where(and(eq(letterAttachments.id, attachmentId), eq(letterAttachments.letterId, letterId)))
    .get()
  if (!att) throw notFound('ไม่พบรูปแนบ')

  database.delete(letterAttachments).where(eq(letterAttachments.id, attachmentId)).run()
  database
    .update(letters)
    .set({ attachmentCount: Math.max(0, row.attachmentCount - 1), updatedAt: now() })
    .where(eq(letters.id, letterId))
    .run()
  await storage().delete(att.imageKey)
  return letterDetail(letterId, database)
}

/**
 * Submitting is where a credit is spent. Read-check-write in one immediate
 * transaction: the balance is read, the ledger row is appended and the letter
 * flips to `queued` together, or none of it happens.
 */
export function submitLetter(
  customerId: string,
  letterId: string,
  ctx: LetterContext = {},
  database: Db = defaultDb()
): LetterDetail {
  const at = now()
  const row = database.select().from(letters).where(eq(letters.id, letterId)).get()
  if (!row) throw notFound('ไม่พบจดหมาย')
  if (row.senderCustomerId !== customerId) throw forbidden('ไม่มีสิทธิ์เข้าถึงจดหมายฉบับนี้')
  if (row.status !== 'draft') throw conflict('จดหมายฉบับนี้ส่งเข้าคิวแล้ว')
  if (row.bodyText.trim() === '' && row.attachmentCount === 0) {
    throw badRequest('จดหมายว่างเปล่า — พิมพ์ข้อความหรือแนบรูปอย่างน้อยหนึ่งอย่าง')
  }
  assertBodyLength(row.bodyText, row.prisonId, database)

  database.transaction(
    (tx) => {
      if (creditBalance(customerId, 'to_prison', tx) < 1) {
        throw conflict('สิทธิ์ส่งจดหมายหมดแล้ว กรุณาซื้อแพ็กเกจก่อน')
      }
      moveCredits(
        {
          customerId,
          direction: 'to_prison',
          delta: -1,
          reason: 'consume',
          refType: 'letter',
          refId: letterId,
          inmateId: row.recipientInmateId,
          prisonId: row.prisonId
        },
        tx,
        at
      )
      tx.update(letters)
        .set({ status: 'queued', queuedAt: at, rejectedReason: null, updatedAt: at })
        .where(eq(letters.id, letterId))
        .run()
    },
    { behavior: 'immediate' }
  )

  writeAudit(
    {
      actorType: 'customer',
      actorId: customerId,
      action: 'letter.queued',
      entity: 'letter',
      entityId: letterId,
      prisonId: row.prisonId,
      before: { status: 'draft' },
      after: { status: 'queued', letterNo: row.letterNo },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )
  return letterDetail(letterId, database)
}

/** Refunds the credit a letter consumed, once, and only if it consumed one. */
function refundLetterCredit(
  letterId: string,
  reason: string,
  tx: DbOrTx,
  at: number,
  actorId: string | null
) {
  const spent = tx
    .select()
    .from(letterCreditLedger)
    .where(
      and(
        eq(letterCreditLedger.refType, 'letter'),
        eq(letterCreditLedger.refId, letterId),
        eq(letterCreditLedger.reason, 'consume')
      )
    )
    .get()
  if (!spent) return false
  const already = tx
    .select()
    .from(letterCreditLedger)
    .where(
      and(
        eq(letterCreditLedger.refType, 'letter'),
        eq(letterCreditLedger.refId, letterId),
        eq(letterCreditLedger.reason, 'refund')
      )
    )
    .get()
  if (already) return false

  moveCredits(
    {
      customerId: spent.customerId,
      direction: spent.direction,
      delta: 1,
      reason: 'refund',
      refType: 'letter',
      refId: letterId,
      inmateId: spent.inmateId,
      prisonId: spent.prisonId,
      note: reason,
      createdBy: actorId
    },
    tx,
    at
  )
  return true
}

/** The relative may pull a letter back until it has been put in a batch. */
export function cancelLetter(
  customerId: string,
  letterId: string,
  database: Db = defaultDb()
): LetterDetail {
  const at = now()
  const row = database.select().from(letters).where(eq(letters.id, letterId)).get()
  if (!row) throw notFound('ไม่พบจดหมาย')
  if (row.senderCustomerId !== customerId) throw forbidden('ไม่มีสิทธิ์เข้าถึงจดหมายฉบับนี้')
  if (row.status !== 'draft' && row.status !== 'queued') {
    throw conflict('จดหมายฉบับนี้เข้ารอบพิมพ์แล้ว ยกเลิกไม่ได้')
  }

  database.transaction(
    (tx) => {
      refundLetterCredit(letterId, 'ผู้ส่งยกเลิกจดหมาย', tx, at, null)
      tx.update(letters)
        .set({
          status: 'rejected',
          rejectedReason: 'ผู้ส่งยกเลิก',
          updatedAt: at
        })
        .where(eq(letters.id, letterId))
        .run()
    },
    { behavior: 'immediate' }
  )

  writeAudit(
    {
      actorType: 'customer',
      actorId: customerId,
      action: 'letter.cancelled',
      entity: 'letter',
      entityId: letterId,
      prisonId: row.prisonId,
      before: { status: row.status },
      after: { status: 'rejected' }
    },
    database
  )
  return letterDetail(letterId, database)
}

/* ── print queue + batches ─────────────────────────────────────────────── */

export const batchSelect = {
  id: letterBatches.id,
  batchNo: letterBatches.batchNo,
  status: letterBatches.status,
  format: letterBatches.format,
  prisonId: letterBatches.prisonId,
  prisonName: prisons.nameTh,
  zoneId: letterBatches.zoneId,
  zoneName: letterBatches.zoneNameSnapshot,
  letterCount: letterBatches.letterCount,
  pdfKey: letterBatches.pdfKey,
  lastError: letterBatches.lastError,
  generatedByName: staff.fullName,
  generatedAt: letterBatches.generatedAt,
  printedAt: letterBatches.printedAt,
  createdAt: letterBatches.createdAt
}

export function letterBatchQuery(db: Db = defaultDb()) {
  return db
    .select(batchSelect)
    .from(letterBatches)
    .innerJoin(prisons, eq(letterBatches.prisonId, prisons.id))
    .leftJoin(staff, eq(letterBatches.generatedBy, staff.id))
}

type BatchRow = ReturnType<ReturnType<typeof letterBatchQuery>['all']>[number]

/** The storage key never leaves the server; the caller gets an API path. */
function toBatchView(row: BatchRow): LetterBatch {
  const { pdfKey, ...rest } = row
  return { ...rest, fileUrl: pdfKey ? `/api/v1/admin/letters/batches/${row.id}/file` : null }
}

export function letterBatchView(batchId: string, db: Db = defaultDb()): LetterBatch {
  const row = letterBatchQuery(db).where(eq(letterBatches.id, batchId)).get()
  if (!row) throw notFound('ไม่พบรอบพิมพ์')
  return toBatchView(row)
}

export function letterBatchList(
  where: ReturnType<typeof and>,
  limit: number,
  db: Db = defaultDb()
): LetterBatch[] {
  return letterBatchQuery(db)
    .where(where)
    .orderBy(desc(letterBatches.createdAt), desc(letterBatches.id))
    .limit(limit)
    .all()
    .map(toBatchView)
}

/**
 * Takes everything currently `queued` for one prison (and optionally one แดน),
 * pins it to a batch inside one write transaction, and hands the drawing off to
 * the job queue. Pinning first is what stops two operators printing the same
 * letter twice.
 */
export function createBatch(
  staffId: string,
  prisonId: string,
  input: CreateLetterBatchInput,
  ctx: LetterContext = {},
  database: Db = defaultDb()
): LetterBatch {
  const at = now()
  const prison = database.select().from(prisons).where(eq(prisons.id, prisonId)).get()
  if (!prison) throw notFound('ไม่พบเรือนจำ')
  const zone = input.zoneId
    ? database.select().from(zones).where(eq(zones.id, input.zoneId)).get()
    : null
  if (input.zoneId && (!zone || zone.prisonId !== prisonId)) throw notFound('ไม่พบแดนนี้ในเรือนจำ')

  const limit = Math.min(
    input.limit ?? getSetting('letter.batch_max', { prisonId, db: database }),
    200
  )

  const batchId = database.transaction(
    (tx) => {
      const pending = tx
        .select({ id: letters.id })
        .from(letters)
        .where(
          and(
            eq(letters.prisonId, prisonId),
            eq(letters.status, 'queued'),
            eq(letters.direction, 'to_prison'),
            input.zoneId ? eq(letters.zoneId, input.zoneId) : undefined
          )
        )
        .orderBy(letters.createdAt, letters.id)
        .limit(limit)
        .all()
      if (pending.length === 0) throw conflict('ไม่มีจดหมายที่รอพิมพ์ตามเงื่อนไขนี้')

      const batchNo = nextLetterBatchNo(prisonId, prison.code, tx, at)
      const id = tx
        .insert(letterBatches)
        .values({
          batchNo,
          prisonId,
          zoneId: input.zoneId ?? null,
          zoneNameSnapshot: zone?.name ?? null,
          letterCount: pending.length,
          status: 'queued',
          generatedBy: staffId,
          createdAt: at,
          updatedAt: at
        })
        .returning({ id: letterBatches.id })
        .get().id

      tx.update(letters)
        .set({ status: 'pending_print', batchId: id, updatedBy: staffId, updatedAt: at })
        .where(
          inArray(
            letters.id,
            pending.map((p) => p.id)
          )
        )
        .run()
      return id
    },
    { behavior: 'immediate' }
  )

  enqueue('letter.batch_pdf', { batchId }, { db: database })

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'letter_batch.created',
      entity: 'letter_batch',
      entityId: batchId,
      prisonId,
      after: { zoneId: input.zoneId ?? null, limit },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )
  return letterBatchView(batchId, database)
}

/** The `letter.batch_pdf` job body. Draws the sheets and stores the file. */
export async function renderBatch(batchId: string, database: Db = defaultDb()) {
  const batch = database.select().from(letterBatches).where(eq(letterBatches.id, batchId)).get()
  if (!batch) throw notFound('ไม่พบรอบพิมพ์')
  const prison = database.select().from(prisons).where(eq(prisons.id, batch.prisonId)).get()

  database
    .update(letterBatches)
    .set({ status: 'rendering', updatedAt: now() })
    .where(eq(letterBatches.id, batchId))
    .run()

  const rows = database
    .select()
    .from(letters)
    .where(eq(letters.batchId, batchId))
    .orderBy(letters.zoneNameSnapshot, letters.letterNo)
    .all()

  const sheets: LetterSheet[] = []
  for (const row of rows) {
    const uris: string[] = []
    for (const att of attachmentsRaw(row.id, database)) {
      try {
        const buf = await storage().get(att.imageKey)
        uris.push(`data:image/jpeg;base64,${buf.toString('base64')}`)
      } catch (err) {
        // A missing photo must not cost the family their letter — print the
        // text and let the audit trail carry the gap.
        console.warn(`[letters] attachment ${att.imageKey} unreadable`, err)
      }
    }
    sheets.push({
      letterNo: row.letterNo,
      createdAt: row.queuedAt ?? row.createdAt,
      senderName: row.customerNameSnapshot ?? '—',
      recipientName: row.inmateNameSnapshot ?? '—',
      inmateCode: row.inmateCodeSnapshot,
      zoneName: row.zoneNameSnapshot,
      prisonName: prison?.nameTh ?? '',
      bodyText: row.bodyText,
      attachmentDataUris: uris
    })
  }

  const html = await renderBatchHtml(
    {
      batchNo: batch.batchNo,
      prisonName: prison?.nameTh ?? '',
      zoneName: batch.zoneNameSnapshot,
      generatedAt: now()
    },
    sheets
  )
  const rendered = await letterRenderer().render(html)
  const stored = await storage().put(rendered.body, {
    prefix: 'letters/batches',
    contentType: rendered.contentType,
    filename: `${batch.batchNo}.${rendered.extension}`
  })

  const at = now()
  database
    .update(letterBatches)
    .set({
      status: 'ready',
      format: rendered.format,
      pdfKey: stored.key,
      letterCount: rows.length,
      lastError: rendered.fallbackReason ?? null,
      generatedAt: at,
      updatedAt: at
    })
    .where(eq(letterBatches.id, batchId))
    .run()

  return { batchId, letters: rows.length, format: rendered.format }
}

function attachmentsRaw(letterId: string, db: Db) {
  return db
    .select()
    .from(letterAttachments)
    .where(eq(letterAttachments.letterId, letterId))
    .orderBy(letterAttachments.sortOrder)
    .all()
}

export function markBatchFailed(batchId: string, error: string, database: Db = defaultDb()) {
  database
    .update(letterBatches)
    .set({ status: 'failed', lastError: error.slice(0, 500), updatedAt: now() })
    .where(eq(letterBatches.id, batchId))
    .run()
}

export async function readBatchFile(batchId: string, database: Db = defaultDb()) {
  const batch = database.select().from(letterBatches).where(eq(letterBatches.id, batchId)).get()
  if (!batch) throw notFound('ไม่พบรอบพิมพ์')
  if (!batch.pdfKey) throw conflict('ไฟล์รอบพิมพ์ยังไม่พร้อม')
  return {
    body: await storage().get(batch.pdfKey),
    contentType: batch.format === 'pdf' ? 'application/pdf' : 'text/html; charset=utf-8',
    filename: `${batch.batchNo}.${batch.format ?? 'pdf'}`
  }
}

/** Marking a batch printed marks every letter in it printed — one action. */
export async function markBatchPrinted(
  staffId: string,
  batchId: string,
  database: Db = defaultDb()
): Promise<LetterBatch> {
  const batch = database.select().from(letterBatches).where(eq(letterBatches.id, batchId)).get()
  if (!batch) throw notFound('ไม่พบรอบพิมพ์')
  if (batch.status === 'queued' || batch.status === 'rendering') {
    throw conflict('ไฟล์รอบพิมพ์ยังไม่พร้อม')
  }

  const at = now()
  const rows = database
    .select()
    .from(letters)
    .where(and(eq(letters.batchId, batchId), eq(letters.status, 'pending_print')))
    .all()

  database
    .update(letters)
    .set({
      status: 'printed',
      printedAt: at,
      printedBy: staffId,
      updatedBy: staffId,
      updatedAt: at
    })
    .where(and(eq(letters.batchId, batchId), eq(letters.status, 'pending_print')))
    .run()
  database
    .update(letterBatches)
    .set({ status: 'printed', printedBy: staffId, printedAt: at, updatedAt: at })
    .where(eq(letterBatches.id, batchId))
    .run()

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'letter_batch.printed',
      entity: 'letter_batch',
      entityId: batchId,
      prisonId: batch.prisonId,
      after: { letters: rows.length }
    },
    database
  )

  for (const row of rows) {
    if (!row.senderCustomerId) continue
    await notify({
      audience: 'customer',
      recipientId: row.senderCustomerId,
      kind: 'letter.printed',
      title: `พิมพ์จดหมาย ${row.letterNo} แล้ว`,
      body: `เจ้าหน้าที่พิมพ์จดหมายถึง ${row.inmateNameSnapshot ?? ''} แล้ว และจะนำส่งตามรอบ`,
      data: { letterId: row.id, letterNo: row.letterNo }
    })
  }

  return letterBatchView(batchId, database)
}

/* ── one letter's status (§4.5) ────────────────────────────────────────── */

const ALLOWED: Record<LetterStatus, LetterStatus[]> = {
  draft: ['rejected'],
  queued: ['printed', 'rejected'],
  pending_print: ['printed', 'rejected'],
  printed: ['dispatched', 'delivered', 'rejected'],
  dispatched: ['delivered', 'rejected'],
  delivered: [],
  rejected: []
}

export async function updateLetterStatus(
  staffId: string,
  letterId: string,
  input: UpdateLetterStatusInput,
  ctx: LetterContext = {},
  database: Db = defaultDb()
): Promise<LetterDetail> {
  const before = database.select().from(letters).where(eq(letters.id, letterId)).get()
  if (!before) throw notFound('ไม่พบจดหมาย')
  if (input.status !== before.status && !ALLOWED[before.status].includes(input.status)) {
    throw conflict(`เปลี่ยนสถานะจาก "${before.status}" เป็น "${input.status}" ไม่ได้`)
  }
  if (input.status === 'rejected' && !input.reason) {
    throw badRequest('ต้องระบุเหตุผลที่ไม่อนุญาต', { reason: ['ต้องระบุเหตุผล'] })
  }

  const at = now()
  let refunded = false
  database.transaction(
    (tx) => {
      // A letter refused before it was handed over never used its coupon.
      if (input.status === 'rejected' && before.status !== 'delivered') {
        refunded = refundLetterCredit(
          letterId,
          input.reason ?? 'เจ้าหน้าที่ไม่อนุญาต',
          tx,
          at,
          staffId
        )
      }
      tx.update(letters)
        .set({
          status: input.status,
          printedAt: input.status === 'printed' ? at : before.printedAt,
          printedBy: input.status === 'printed' ? staffId : before.printedBy,
          dispatchedAt: input.status === 'dispatched' ? at : before.dispatchedAt,
          deliveredAt: input.status === 'delivered' ? at : before.deliveredAt,
          rejectedReason: input.status === 'rejected' ? (input.reason ?? null) : null,
          updatedBy: staffId,
          updatedAt: at
        })
        .where(eq(letters.id, letterId))
        .run()
    },
    { behavior: 'immediate' }
  )

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: `letter.${input.status}`,
      entity: 'letter',
      entityId: letterId,
      prisonId: before.prisonId,
      before: { status: before.status },
      after: { status: input.status, reason: input.reason, creditRefunded: refunded },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )

  const recipient = before.senderCustomerId ?? before.recipientCustomerId
  if (recipient && (input.status === 'delivered' || input.status === 'rejected')) {
    await notify({
      audience: 'customer',
      recipientId: recipient,
      kind: 'letter.printed',
      title:
        input.status === 'delivered'
          ? `ส่งจดหมาย ${before.letterNo} ถึงมือแล้ว`
          : `จดหมาย ${before.letterNo} ไม่ผ่านการตรวจ`,
      body:
        input.status === 'delivered'
          ? 'เจ้าหน้าที่นำส่งจดหมายเรียบร้อยแล้ว'
          : `${input.reason ?? 'กรุณาติดต่อเจ้าหน้าที่'}${refunded ? ' (คืนสิทธิ์ให้แล้ว 1 ฉบับ)' : ''}`,
      data: { letterId, letterNo: before.letterNo, status: input.status }
    })
  }

  return letterDetail(letterId, database)
}

/* ── scan-reply intake (p.6) ───────────────────────────────────────────── */

/**
 * The inmate writes on the printed sheet, staff scan it, and the QR that was
 * designed into the template from day one says which outgoing letter — and so
 * which family — it belongs to.
 */
export async function scanReply(
  staffId: string,
  file: { buffer: Buffer; contentType?: string; filename?: string },
  input: { letterNo?: string } = {},
  ctx: LetterContext = {},
  database: Db = defaultDb()
): Promise<ScanReplyResult> {
  const image = await normalizeLetterImage(file.buffer, {
    declaredType: file.contentType,
    maxEdge: 2200,
    maxBytes: 16 * 1024 * 1024,
    label: 'ไฟล์สแกน'
  })

  // Staff may type the number when the QR is smudged; the scan still wins if
  // it reads, because a typed number is the thing most likely to be wrong.
  const fromQr = await decodeReplyQr(image.buffer)
  const letterNo = fromQr ?? input.letterNo?.trim().toUpperCase() ?? null
  if (!letterNo) {
    return {
      matchedLetterNo: null,
      letter: null,
      awaitingCredit: false,
      message: 'อ่าน QR บนใบตอบกลับไม่ได้ กรุณาสแกนใหม่หรือกรอกเลขที่จดหมายด้วยตนเอง'
    }
  }

  const parent = database.select().from(letters).where(eq(letters.letterNo, letterNo)).get()
  if (!parent) {
    return {
      matchedLetterNo: letterNo,
      letter: null,
      awaitingCredit: false,
      message: `ไม่พบจดหมายเลขที่ ${letterNo} ในระบบ`
    }
  }
  const existing = database
    .select({ id: letters.id })
    .from(letters)
    .where(eq(letters.replyToLetterId, parent.id))
    .get()
  if (existing) throw conflict(`จดหมาย ${letterNo} มีคำตอบกลับในระบบแล้ว`)
  if (!parent.senderCustomerId) throw conflict('จดหมายต้นทางไม่มีผู้รับปลายทางที่ระบุได้')

  const stored = await storage().put(image.buffer, {
    prefix: 'letters/scans',
    contentType: image.contentType,
    filename: `${letterNo}.jpg`
  })

  const at = now()
  const prison = database.select().from(prisons).where(eq(prisons.id, parent.prisonId)).get()!
  const consumes = getSetting('letter.reply_consumes_credit', {
    prisonId: parent.prisonId,
    db: database
  })

  let awaitingCredit = false
  const replyId = database.transaction(
    (tx) => {
      const spent = consumes ? creditBalance(parent.senderCustomerId!, 'to_home', tx) >= 1 : true
      awaitingCredit = !spent
      const letterNoNew = nextLetterNo(prison.id, prison.code, tx, at)

      const id = tx
        .insert(letters)
        .values({
          letterNo: letterNoNew,
          direction: 'to_home',
          senderInmateId: parent.recipientInmateId,
          recipientCustomerId: parent.senderCustomerId,
          prisonId: parent.prisonId,
          zoneId: parent.zoneId,
          zoneNameSnapshot: parent.zoneNameSnapshot,
          inmateCodeSnapshot: parent.inmateCodeSnapshot,
          inmateNameSnapshot: parent.inmateNameSnapshot,
          customerNameSnapshot: parent.customerNameSnapshot,
          bodyText: '',
          scanImageKey: stored.key,
          // Held as `queued` until the family holds a ส่งกลับบ้าน coupon; the
          // scan is stored either way, because the paper only passes once.
          status: spent ? 'delivered' : 'queued',
          deliveredAt: spent ? at : null,
          replyToLetterId: parent.id,
          createdAt: at,
          updatedAt: at,
          updatedBy: staffId
        })
        .returning({ id: letters.id })
        .get().id

      if (spent && consumes) {
        moveCredits(
          {
            customerId: parent.senderCustomerId!,
            direction: 'to_home',
            delta: -1,
            reason: 'consume',
            refType: 'letter',
            refId: id,
            inmateId: parent.recipientInmateId,
            prisonId: parent.prisonId,
            createdBy: staffId
          },
          tx,
          at
        )
      }
      // The outgoing letter is provably in the inmate's hands: they wrote back.
      if (parent.status !== 'delivered') {
        tx.update(letters)
          .set({ status: 'delivered', deliveredAt: at, updatedBy: staffId, updatedAt: at })
          .where(eq(letters.id, parent.id))
          .run()
      }
      return id
    },
    { behavior: 'immediate' }
  )

  writeAudit(
    {
      actorType: 'staff',
      actorId: staffId,
      action: 'letter.reply_scanned',
      entity: 'letter',
      entityId: replyId,
      prisonId: parent.prisonId,
      after: { replyTo: parent.letterNo, awaitingCredit },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )

  await notify({
    audience: 'customer',
    recipientId: parent.senderCustomerId,
    kind: 'letter.printed',
    title: awaitingCredit ? 'มีจดหมายตอบกลับรอเปิดอ่าน' : 'มีจดหมายตอบกลับจากผู้ต้องขัง',
    body: awaitingCredit
      ? 'ซื้อแพ็กเกจ "ส่งกลับบ้าน" เพื่อเปิดอ่านจดหมายตอบกลับฉบับนี้'
      : `${parent.inmateNameSnapshot ?? 'ผู้ต้องขัง'} ตอบกลับจดหมาย ${parent.letterNo} ของคุณแล้ว`,
    data: { letterId: replyId, replyTo: parent.letterNo }
  })

  return {
    matchedLetterNo: letterNo,
    letter: letterDetail(replyId, database),
    awaitingCredit,
    message: awaitingCredit
      ? 'บันทึกจดหมายตอบกลับแล้ว — รอญาติซื้อแพ็กเกจ "ส่งกลับบ้าน" จึงจะเปิดอ่านได้'
      : 'บันทึกและส่งจดหมายตอบกลับถึงญาติแล้ว'
  }
}

/* ── reading stored files ──────────────────────────────────────────────── */

export async function readAttachment(letterId: string, attachmentId: string, db: Db = defaultDb()) {
  const att = db
    .select()
    .from(letterAttachments)
    .where(and(eq(letterAttachments.id, attachmentId), eq(letterAttachments.letterId, letterId)))
    .get()
  if (!att) throw notFound('ไม่พบรูปแนบ')
  return storage().get(att.imageKey)
}

export async function readScan(letterId: string, db: Db = defaultDb()) {
  const row = db.select().from(letters).where(eq(letters.id, letterId)).get()
  if (!row?.scanImageKey) throw notFound('ไม่พบไฟล์สแกน')
  return storage().get(row.scanImageKey)
}

/* ── dashboard tile / p.12 report ──────────────────────────────────────── */

export function letterTotals(
  prisonId: string | null,
  range: { from?: number; to?: number } = {},
  database: Db = defaultDb()
): LetterSummaryTotals {
  const where = and(
    prisonId ? eq(letters.prisonId, prisonId) : undefined,
    range.from ? gte(letters.createdAt, range.from) : undefined,
    range.to ? lte(letters.createdAt, range.to) : undefined
  )

  const rows = database
    .select({ direction: letters.direction, status: letters.status, n: count() })
    .from(letters)
    .where(where)
    .groupBy(letters.direction, letters.status)
    .all()

  const sum = (pred: (r: (typeof rows)[number]) => boolean) =>
    rows.filter(pred).reduce((acc, r) => acc + r.n, 0)

  const sold =
    database
      .select({ total: sql<number>`coalesce(sum(${letterPurchases.priceSatang}), 0)` })
      .from(letterPurchases)
      .where(
        and(
          eq(letterPurchases.status, 'paid'),
          prisonId ? eq(letterPurchases.prisonId, prisonId) : undefined,
          range.from ? gte(letterPurchases.createdAt, range.from) : undefined,
          range.to ? lte(letterPurchases.createdAt, range.to) : undefined
        )
      )
      .get()?.total ?? 0

  return {
    from: range.from ?? null,
    to: range.to ?? null,
    buckets: rows.map((r) => ({ direction: r.direction, status: r.status, count: r.n })),
    awaitingPrintCount: sum((r) => r.status === 'queued' || r.status === 'pending_print'),
    printedCount: sum((r) => r.status === 'printed'),
    deliveredCount: sum((r) => r.status === 'delivered'),
    creditsSoldSatang: sold
  }
}

export const letterOrder = [desc(letters.createdAt), desc(letters.id)] as const
