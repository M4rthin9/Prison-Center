import { relations } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { id, satang, timestamps, ts } from './_shared.js'
import { prisons, inmates, zones } from './facility.js'
import { customers } from './people.js'
import { products, shops } from './catalog.js'

export type PaymentStatus =
  'unpaid' | 'awaiting_verify' | 'paid' | 'failed' | 'refunded' | 'expired'
export type FulfillmentStatus = 'new' | 'preparing' | 'delivered' | 'cancelled'

export const orders = sqliteTable(
  'orders',
  {
    id: id(),
    /** {PRISON_CODE}-{YYMM}-{SEQ}, numbered inside the insert transaction. */
    orderNo: text('order_no').notNull(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'restrict' }),
    inmateId: text('inmate_id')
      .notNull()
      .references(() => inmates.id, { onDelete: 'restrict' }),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'restrict' }),
    prisonId: text('prison_id')
      .notNull()
      .references(() => prisons.id, { onDelete: 'restrict' }),
    /**
     * Snapshot of the inmate's แดน at order time. A zone transfer must not
     * retroactively rewrite last month's reports (§4.1) — so this is a stored
     * value, never a live join.
     */
    zoneId: text('zone_id').references(() => zones.id, { onDelete: 'set null' }),
    zoneNameSnapshot: text('zone_name_snapshot'),
    inmateCodeSnapshot: text('inmate_code_snapshot').notNull(),
    inmateNameSnapshot: text('inmate_name_snapshot').notNull(),

    subtotalSatang: satang('subtotal_satang').notNull(),
    discountSatang: satang('discount_satang').notNull().default(0),
    totalSatang: satang('total_satang').notNull(),

    paymentStatus: text('payment_status').$type<PaymentStatus>().notNull().default('unpaid'),
    fulfillmentStatus: text('fulfillment_status')
      .$type<FulfillmentStatus>()
      .notNull()
      .default('new'),
    note: text('note'),
    cancelReason: text('cancel_reason'),

    orderedAt: ts('ordered_at').notNull(),
    paidAt: ts('paid_at'),
    fulfilledAt: ts('fulfilled_at'),
    cancelledAt: ts('cancelled_at'),
    ...timestamps(),
    updatedBy: text('updated_by')
  },
  (t) => [
    uniqueIndex('uq_orders_order_no').on(t.orderNo),
    index('idx_orders_prison_date').on(t.prisonId, t.orderedAt),
    index('idx_orders_paystatus').on(t.paymentStatus, t.orderedAt),
    index('idx_orders_fulfillment').on(t.prisonId, t.fulfillmentStatus, t.orderedAt),
    index('idx_orders_customer').on(t.customerId, t.orderedAt),
    // §7 reports run department-wide, so `prison_id` is often unbound and the
    // composite indexes above cannot be used. EXPLAIN QUERY PLAN turned this
    // one from SCAN orders into a range search.
    index('idx_orders_ordered_at').on(t.orderedAt)
  ]
)

/**
 * Product fields are snapshotted onto the line. The sales report (p. 12) groups
 * historical sales by product — joining live to `products` would let a price
 * edit silently rewrite last month's figures.
 */
export const orderItems = sqliteTable(
  'order_items',
  {
    id: id(),
    orderId: text('order_id')
      .notNull()
      .references(() => orders.id, { onDelete: 'cascade' }),
    productId: text('product_id').references(() => products.id, { onDelete: 'set null' }),
    skuSnapshot: text('sku_snapshot').notNull(),
    nameSnapshot: text('name_snapshot').notNull(),
    unitSnapshot: text('unit_snapshot').notNull(),
    categoryNameSnapshot: text('category_name_snapshot'),
    unitPriceSatang: satang('unit_price_satang').notNull(),
    qty: integer('qty').notNull(),
    lineTotalSatang: satang('line_total_satang').notNull(),
    createdAt: ts('created_at')
      .notNull()
      .$defaultFn(() => Date.now())
  },
  (t) => [
    index('idx_order_items_order').on(t.orderId),
    index('idx_order_items_product').on(t.productId)
  ]
)

export const ordersRelations = relations(orders, ({ one, many }) => ({
  customer: one(customers, { fields: [orders.customerId], references: [customers.id] }),
  inmate: one(inmates, { fields: [orders.inmateId], references: [inmates.id] }),
  shop: one(shops, { fields: [orders.shopId], references: [shops.id] }),
  prison: one(prisons, { fields: [orders.prisonId], references: [prisons.id] }),
  items: many(orderItems)
}))

export const orderItemsRelations = relations(orderItems, ({ one }) => ({
  order: one(orders, { fields: [orderItems.orderId], references: [orders.id] }),
  product: one(products, { fields: [orderItems.productId], references: [products.id] })
}))
