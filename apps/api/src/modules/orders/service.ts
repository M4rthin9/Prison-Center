import { and, asc, eq, inArray } from 'drizzle-orm'
import type { CreateOrderInput } from '@pc/contract'
import { db as defaultDb, type Db } from '../../db/client.js'
import {
  categories,
  customerInmates,
  customers,
  inmates,
  orderItems,
  orders,
  prisons,
  products,
  shops,
  zones
} from '../../db/schema/index.js'
import { writeAudit } from '../../lib/audit.js'
import { nextOrderNo } from '../../lib/counters.js'
import { badRequest, conflict, forbidden, notFound } from '../../lib/errors.js'
import { now } from '../../lib/time.js'
import { getSetting } from '../settings/service.js'
import { effectiveHours, isBeforeCutoff, isOpenAt } from '../catalog/service.js'

export interface OrderContext {
  ip?: string | null
  userAgent?: string | null
}

/* ── views ─────────────────────────────────────────────────────────────── */

const summarySelect = {
  id: orders.id,
  orderNo: orders.orderNo,
  shopId: orders.shopId,
  shopName: shops.name,
  prisonId: orders.prisonId,
  prisonName: prisons.nameTh,
  inmateId: orders.inmateId,
  inmateCode: orders.inmateCodeSnapshot,
  inmateName: orders.inmateNameSnapshot,
  zoneName: orders.zoneNameSnapshot,
  totalSatang: orders.totalSatang,
  paymentStatus: orders.paymentStatus,
  fulfillmentStatus: orders.fulfillmentStatus,
  orderedAt: orders.orderedAt
}

export function orderSummaryQuery(db: Db = defaultDb()) {
  return db
    .select(summarySelect)
    .from(orders)
    .innerJoin(shops, eq(orders.shopId, shops.id))
    .innerJoin(prisons, eq(orders.prisonId, prisons.id))
}

/** Item counts for a page of orders — one grouped query, never per row. */
export function itemCounts(orderIds: string[], db: Db = defaultDb()): Map<string, number> {
  if (orderIds.length === 0) return new Map()
  const rows = db
    .select({ orderId: orderItems.orderId, qty: orderItems.qty })
    .from(orderItems)
    .where(inArray(orderItems.orderId, orderIds))
    .all()
  const map = new Map<string, number>()
  for (const r of rows) map.set(r.orderId, (map.get(r.orderId) ?? 0) + r.qty)
  return map
}

export function orderDetail(orderId: string, db: Db = defaultDb()) {
  const row = db.select().from(orders).where(eq(orders.id, orderId)).get()
  if (!row) throw notFound('ไม่พบคำสั่งซื้อ')

  const shop = db.select().from(shops).where(eq(shops.id, row.shopId)).get()
  const prison = db.select().from(prisons).where(eq(prisons.id, row.prisonId)).get()
  const customer = db.select().from(customers).where(eq(customers.id, row.customerId)).get()

  const items = db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, orderId))
    .orderBy(asc(orderItems.createdAt), asc(orderItems.id))
    .all()

  return {
    id: row.id,
    orderNo: row.orderNo,
    shopId: row.shopId,
    shopName: shop?.name ?? null,
    prisonId: row.prisonId,
    prisonName: prison?.nameTh ?? null,
    inmateId: row.inmateId,
    inmateCode: row.inmateCodeSnapshot,
    inmateName: row.inmateNameSnapshot,
    zoneName: row.zoneNameSnapshot,
    customerId: row.customerId,
    customerName: customer?.fullName ?? '',
    customerPhone: customer?.phone ?? '',
    itemCount: items.reduce((n, i) => n + i.qty, 0),
    subtotalSatang: row.subtotalSatang,
    discountSatang: row.discountSatang,
    totalSatang: row.totalSatang,
    paymentStatus: row.paymentStatus,
    fulfillmentStatus: row.fulfillmentStatus,
    note: row.note,
    cancelReason: row.cancelReason,
    orderedAt: row.orderedAt,
    paidAt: row.paidAt,
    fulfilledAt: row.fulfilledAt,
    cancelledAt: row.cancelledAt,
    items: items.map((i) => ({
      id: i.id,
      productId: i.productId,
      sku: i.skuSnapshot,
      name: i.nameSnapshot,
      unit: i.unitSnapshot,
      categoryName: i.categoryNameSnapshot,
      unitPriceSatang: i.unitPriceSatang,
      qty: i.qty,
      lineTotalSatang: i.lineTotalSatang
    }))
  }
}

/* ── placing an order ──────────────────────────────────────────────────── */

/** Same product twice in one cart is a UI accident, not two lines. */
function mergeLines(items: CreateOrderInput['items']) {
  const merged = new Map<string, number>()
  for (const line of items) merged.set(line.productId, (merged.get(line.productId) ?? 0) + line.qty)
  return [...merged].map(([productId, qty]) => ({ productId, qty }))
}

/**
 * Everything about an order is decided here, server-side: the relative's link
 * must be verified, the shop must belong to the inmate's facility, and every
 * price is read from `products` — the client's cart carries quantities only.
 */
export function placeOrder(
  customerId: string,
  input: CreateOrderInput,
  ctx: OrderContext = {},
  database: Db = defaultDb()
) {
  const at = now()

  const inmate = database.select().from(inmates).where(eq(inmates.id, input.inmateId)).get()
  if (!inmate || inmate.deletedAt) throw notFound('ไม่พบผู้ต้องขัง')
  if (inmate.status !== 'active') {
    throw conflict('ผู้ต้องขังรายนี้ไม่ได้อยู่ในเรือนจำแล้ว จึงสั่งซื้อสินค้าให้ไม่ได้')
  }

  // The verification gate: no money moves against an unverified link (§4.1b).
  const link = database
    .select()
    .from(customerInmates)
    .where(
      and(eq(customerInmates.customerId, customerId), eq(customerInmates.inmateId, input.inmateId))
    )
    .get()
  if (!link) throw forbidden('บัญชีของคุณยังไม่ได้ผูกกับผู้ต้องขังรายนี้')
  if (link.verifyStatus !== 'verified') {
    throw forbidden('คำขอผูกบัญชีกับผู้ต้องขังรายนี้ยังไม่ได้รับการยืนยันจากเจ้าหน้าที่')
  }

  const shop = database.select().from(shops).where(eq(shops.id, input.shopId)).get()
  if (!shop || !shop.isActive) throw notFound('ไม่พบร้านค้า')
  if (shop.prisonId !== inmate.prisonId) {
    throw badRequest('ร้านค้านี้ไม่ได้ให้บริการเรือนจำของผู้ต้องขังรายนี้')
  }
  if (shop.zoneId && shop.zoneId !== inmate.zoneId) {
    throw badRequest('ร้านค้านี้ให้บริการเฉพาะบางแดนเท่านั้น')
  }

  if (getSetting('order.enforce_shop_hours', { prisonId: shop.prisonId, db: database })) {
    const hours = effectiveHours([shop.id], new Map([[shop.id, shop.prisonId]]), database).get(
      shop.id
    )
    if (!hours || !isOpenAt(hours.hours, at)) throw conflict('ขณะนี้ร้านค้าปิดทำการ')
    if (!isBeforeCutoff(shop.prisonId, at, database)) {
      throw conflict('เลยเวลาปิดรับคำสั่งซื้อประจำวันแล้ว')
    }
  }

  const lines = mergeLines(input.items)
  const maxLines = getSetting('order.max_lines', { prisonId: shop.prisonId, db: database })
  if (lines.length > maxLines) throw badRequest(`สั่งซื้อได้สูงสุด ${maxLines} รายการต่อครั้ง`)

  const found = database
    .select()
    .from(products)
    .where(
      inArray(
        products.id,
        lines.map((l) => l.productId)
      )
    )
    .all()
  const byId = new Map(found.map((p) => [p.id, p]))

  const categoryIds = found.map((p) => p.categoryId).filter((v): v is string => v !== null)
  const categoryNames = new Map(
    categoryIds.length === 0
      ? []
      : database
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(inArray(categories.id, categoryIds))
          .all()
          .map((r) => [r.id, r.name])
  )

  const priced = lines.map((line) => {
    const product = byId.get(line.productId)
    if (!product || !product.isActive) throw badRequest('มีสินค้าในตะกร้าที่ไม่มีจำหน่ายแล้ว')
    if (product.shopId !== shop.id) throw badRequest('มีสินค้าในตะกร้าที่ไม่ได้อยู่ในร้านนี้')
    if (product.maxPerOrder > 0 && line.qty > product.maxPerOrder) {
      throw badRequest(
        `"${product.name}" สั่งได้สูงสุด ${product.maxPerOrder} ${product.unit} ต่อครั้ง`
      )
    }
    return {
      product,
      qty: line.qty,
      // Integer satang throughout — the multiplication never leaves the integers.
      lineTotalSatang: product.priceSatang * line.qty
    }
  })

  const subtotalSatang = priced.reduce((sum, l) => sum + l.lineTotalSatang, 0)
  const discountSatang = 0
  const zone = inmate.zoneId
    ? database.select().from(zones).where(eq(zones.id, inmate.zoneId)).get()
    : null
  const prison = database.select().from(prisons).where(eq(prisons.id, shop.prisonId)).get()
  if (!prison) throw notFound('ไม่พบเรือนจำ')

  // BEGIN IMMEDIATE: the order number is allocated from `counters` and consumed
  // by the insert in one write transaction, so two carts can never share one.
  const orderId = database.transaction(
    (tx) => {
      const orderNo = nextOrderNo(prison.id, prison.code, tx, at)
      const order = tx
        .insert(orders)
        .values({
          orderNo,
          customerId,
          inmateId: inmate.id,
          shopId: shop.id,
          prisonId: prison.id,
          zoneId: inmate.zoneId,
          zoneNameSnapshot: zone?.name ?? null,
          inmateCodeSnapshot: inmate.inmateCode,
          inmateNameSnapshot: inmate.fullName,
          subtotalSatang,
          discountSatang,
          totalSatang: subtotalSatang - discountSatang,
          paymentStatus: 'unpaid',
          fulfillmentStatus: 'new',
          note: input.note ?? null,
          orderedAt: at
        })
        .returning({ id: orders.id })
        .get()

      for (const line of priced) {
        tx.insert(orderItems)
          .values({
            orderId: order.id,
            productId: line.product.id,
            skuSnapshot: line.product.sku,
            nameSnapshot: line.product.name,
            unitSnapshot: line.product.unit,
            categoryNameSnapshot: line.product.categoryId
              ? (categoryNames.get(line.product.categoryId) ?? null)
              : null,
            unitPriceSatang: line.product.priceSatang,
            qty: line.qty,
            lineTotalSatang: line.lineTotalSatang
          })
          .run()
      }

      return order.id
    },
    { behavior: 'immediate' }
  )

  const detail = orderDetail(orderId, database)
  writeAudit(
    {
      actorType: 'customer',
      actorId: customerId,
      action: 'order.created',
      entity: 'order',
      entityId: orderId,
      prisonId: prison.id,
      after: {
        orderNo: detail.orderNo,
        inmateId: inmate.id,
        shopId: shop.id,
        totalSatang: detail.totalSatang,
        lines: priced.length
      },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )
  return detail
}

/* ── fulfillment ───────────────────────────────────────────────────────── */

const ALLOWED: Record<string, string[]> = {
  new: ['preparing', 'delivered', 'cancelled'],
  preparing: ['delivered', 'cancelled'],
  delivered: [],
  cancelled: []
}

export function assertFulfillmentTransition(from: string, to: string) {
  if (from === to) return
  if (!ALLOWED[from]?.includes(to)) {
    throw conflict(`เปลี่ยนสถานะจาก "${from}" เป็น "${to}" ไม่ได้`)
  }
}
