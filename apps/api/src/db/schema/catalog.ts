import { relations } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { bool, id, satang, timestamps } from './_shared.js'
import { prisons, zones } from './facility.js'

/* ── shops (p. 3) ──────────────────────────────────────────────────────── */

/** ร้านค้าฝึกอาชีพฯ / ผลิตภัณฑ์ราชทัณฑ์ */
export type ShopType = 'vocational_training' | 'prison_products'

export const shops = sqliteTable(
  'shops',
  {
    id: id(),
    prisonId: text('prison_id')
      .notNull()
      .references(() => prisons.id, { onDelete: 'restrict' }),
    /** NULL == serves every แดน in the facility. */
    zoneId: text('zone_id').references(() => zones.id, { onDelete: 'set null' }),
    name: text('name').notNull(),
    shopType: text('shop_type').$type<ShopType>().notNull().default('prison_products'),
    description: text('description'),
    imageKey: text('image_key'),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: bool('is_active', true),
    ...timestamps(),
    createdBy: text('created_by'),
    updatedBy: text('updated_by')
  },
  (t) => [
    uniqueIndex('uq_shops_prison_name').on(t.prisonId, t.name),
    index('idx_shops_prison').on(t.prisonId, t.isActive, t.sortOrder)
  ]
)

/**
 * Per-shop opening hours. A shop with no rows inherits the facility-wide
 * `shop.hours` setting, so a new shop is usable before anyone edits a schedule.
 */
export const shopHours = sqliteTable(
  'shop_hours',
  {
    id: id(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'cascade' }),
    /** 0 = Sunday, matching `Date#getDay` and the `shop.hours` setting. */
    weekday: integer('weekday').notNull(),
    opensAt: text('opens_at').notNull(),
    closesAt: text('closes_at').notNull(),
    isOpen: bool('is_open', true),
    ...timestamps()
  },
  (t) => [uniqueIndex('uq_shop_hours_day').on(t.shopId, t.weekday)]
)

/* ── categories ────────────────────────────────────────────────────────── */

/**
 * Categories are department-wide (§4.2), not per prison: the sales report
 * groups by category across facilities. Only super_admin may write them.
 */
export const categories = sqliteTable(
  'categories',
  {
    id: id(),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
    isActive: bool('is_active', true),
    ...timestamps()
  },
  (t) => [uniqueIndex('uq_categories_name').on(t.name)]
)

/* ── products ──────────────────────────────────────────────────────────── */

/** สินค้าบรรจุภัณฑ์ / อาหาร&เครื่องดื่ม */
export type ProductType = 'packaged_goods' | 'food_beverage'

export const products = sqliteTable(
  'products',
  {
    id: id(),
    shopId: text('shop_id')
      .notNull()
      .references(() => shops.id, { onDelete: 'restrict' }),
    categoryId: text('category_id').references(() => categories.id, { onDelete: 'set null' }),
    sku: text('sku').notNull(),
    name: text('name').notNull(),
    description: text('description'),
    /** INTEGER satang. Never float, never decimal-as-text. */
    priceSatang: satang('price_satang').notNull(),
    unit: text('unit').notNull().default('ชิ้น'),
    imageKey: text('image_key'),
    productType: text('product_type').$type<ProductType>().notNull().default('packaged_goods'),
    /** 0 == no per-order cap. */
    maxPerOrder: integer('max_per_order').notNull().default(0),
    isActive: bool('is_active', true),
    ...timestamps(),
    createdBy: text('created_by'),
    updatedBy: text('updated_by')
  },
  (t) => [
    uniqueIndex('uq_products_shop_sku').on(t.shopId, t.sku),
    index('idx_products_shop_cat').on(t.shopId, t.categoryId, t.isActive),
    index('idx_products_name').on(t.name)
  ]
)

/* ── relations ─────────────────────────────────────────────────────────── */

export const shopsRelations = relations(shops, ({ one, many }) => ({
  prison: one(prisons, { fields: [shops.prisonId], references: [prisons.id] }),
  zone: one(zones, { fields: [shops.zoneId], references: [zones.id] }),
  hours: many(shopHours),
  products: many(products)
}))

export const shopHoursRelations = relations(shopHours, ({ one }) => ({
  shop: one(shops, { fields: [shopHours.shopId], references: [shops.id] })
}))

export const productsRelations = relations(products, ({ one }) => ({
  shop: one(shops, { fields: [products.shopId], references: [shops.id] }),
  category: one(categories, { fields: [products.categoryId], references: [categories.id] })
}))

export const categoriesRelations = relations(categories, ({ many }) => ({
  products: many(products)
}))
