import { and, count, eq, inArray } from 'drizzle-orm'
import { db as defaultDb, type Db } from '../../db/client.js'
import {
  categories,
  prisons,
  products,
  shopHours,
  shops,
  zones,
  type ProductType,
  type ShopType
} from '../../db/schema/index.js'
import { BANGKOK_OFFSET_MS, now } from '../../lib/time.js'
import { getSetting } from '../settings/service.js'

export interface Hour {
  weekday: number
  opensAt: string
  closesAt: string
  isOpen: boolean
}

export interface EffectiveHours {
  hours: Hour[]
  source: 'shop' | 'prison'
}

/** Bangkok is UTC+7 with no DST, so shifting the epoch is the whole conversion. */
export function bangkokClock(at: number = now()) {
  const local = new Date(at + BANGKOK_OFFSET_MS)
  return { weekday: local.getUTCDay(), hhmm: local.toISOString().slice(11, 16) }
}

const byWeekday = (rows: Hour[]) => {
  const map = new Map<number, Hour>()
  for (const r of rows) map.set(r.weekday, r)
  return map
}

/**
 * A shop with no `shop_hours` rows inherits the facility-wide `shop.hours`
 * setting — so a shop created this morning is already open on the right days.
 * Rows that do exist win, day by day.
 */
export function effectiveHours(
  shopIds: string[],
  prisonIdByShop: Map<string, string>,
  db: Db = defaultDb()
): Map<string, EffectiveHours> {
  const rows =
    shopIds.length === 0
      ? []
      : db.select().from(shopHours).where(inArray(shopHours.shopId, shopIds)).all()

  const byShop = new Map<string, Hour[]>()
  for (const r of rows) {
    const list = byShop.get(r.shopId) ?? []
    list.push({ weekday: r.weekday, opensAt: r.opensAt, closesAt: r.closesAt, isOpen: r.isOpen })
    byShop.set(r.shopId, list)
  }

  const prisonHours = new Map<string, Hour[]>()
  const out = new Map<string, EffectiveHours>()

  for (const shopId of shopIds) {
    const prisonId = prisonIdByShop.get(shopId) ?? null
    if (prisonId && !prisonHours.has(prisonId)) {
      prisonHours.set(prisonId, getSetting('shop.hours', { prisonId, db }) as Hour[])
    }
    const fallback = (prisonId ? prisonHours.get(prisonId) : null) ?? []
    const own = byWeekday(byShop.get(shopId) ?? [])
    const hours: Hour[] = []
    for (let weekday = 0; weekday < 7; weekday++) {
      hours.push(
        own.get(weekday) ??
          fallback.find((h) => h.weekday === weekday) ?? {
            weekday,
            opensAt: '08:30',
            closesAt: '16:30',
            isOpen: weekday !== 0
          }
      )
    }
    out.set(shopId, { hours, source: own.size > 0 ? 'shop' : 'prison' })
  }
  return out
}

export function isOpenAt(hours: Hour[], at: number = now()): boolean {
  const { weekday, hhmm } = bangkokClock(at)
  const today = hours.find((h) => h.weekday === weekday)
  if (!today || !today.isOpen) return false
  return hhmm >= today.opensAt && hhmm < today.closesAt
}

/** `order.cutoff_time` closes the day earlier than the shop does (p. 3). */
export function isBeforeCutoff(prisonId: string, at: number = now(), db: Db = defaultDb()) {
  const cutoff = getSetting('order.cutoff_time', { prisonId, db })
  return bangkokClock(at).hhmm < cutoff
}

/** Loads one shop row with the scope check left to the caller. */
export function shopRow(shopId: string, db: Db = defaultDb()) {
  return db.select().from(shops).where(eq(shops.id, shopId)).get()
}

export function activeShopRow(shopId: string, db: Db = defaultDb()) {
  return db
    .select()
    .from(shops)
    .where(and(eq(shops.id, shopId), eq(shops.isActive, true)))
    .get()
}

/* ── views ─────────────────────────────────────────────────────────────── */

export interface ShopView {
  id: string
  prisonId: string
  prisonName: string | null
  zoneId: string | null
  zoneName: string | null
  name: string
  shopType: ShopType
  description: string | null
  imageKey: string | null
  sortOrder: number
  isActive: boolean
  isOpenNow: boolean
  productCount: number
}

/**
 * Names and product counts are fetched per id-set rather than joined per row:
 * three small `IN` queries beat a join that has to be grouped, and none of them
 * can be silently miscorrelated.
 */
export function decorateShops(
  rows: (typeof shops.$inferSelect)[],
  db: Db = defaultDb(),
  at: number = now()
): (ShopView & { hours: Hour[]; hoursSource: 'shop' | 'prison' })[] {
  if (rows.length === 0) return []
  const shopIds = rows.map((r) => r.id)
  const prisonIdByShop = new Map(rows.map((r) => [r.id, r.prisonId]))

  const counts = new Map(
    db
      .select({ shopId: products.shopId, n: count(products.id) })
      .from(products)
      .where(and(inArray(products.shopId, shopIds), eq(products.isActive, true)))
      .groupBy(products.shopId)
      .all()
      .map((r) => [r.shopId, r.n])
  )

  const prisonNames = new Map(
    db
      .select({ id: prisons.id, name: prisons.nameTh })
      .from(prisons)
      .where(inArray(prisons.id, [...new Set(rows.map((r) => r.prisonId))]))
      .all()
      .map((r) => [r.id, r.name])
  )

  const zoneIds = rows.map((r) => r.zoneId).filter((v): v is string => v !== null)
  const zoneNames = new Map(
    zoneIds.length === 0
      ? []
      : db
          .select({ id: zones.id, name: zones.name })
          .from(zones)
          .where(inArray(zones.id, zoneIds))
          .all()
          .map((r) => [r.id, r.name])
  )

  const hours = effectiveHours(shopIds, prisonIdByShop, db)

  return rows.map((r) => {
    const h = hours.get(r.id) ?? { hours: [], source: 'prison' as const }
    return {
      id: r.id,
      prisonId: r.prisonId,
      prisonName: prisonNames.get(r.prisonId) ?? null,
      zoneId: r.zoneId,
      zoneName: r.zoneId ? (zoneNames.get(r.zoneId) ?? null) : null,
      name: r.name,
      shopType: r.shopType,
      description: r.description,
      imageKey: r.imageKey,
      sortOrder: r.sortOrder,
      isActive: r.isActive,
      isOpenNow: r.isActive && isOpenAt(h.hours, at),
      productCount: counts.get(r.id) ?? 0,
      hours: h.hours,
      hoursSource: h.source
    }
  })
}

export interface ProductView {
  id: string
  shopId: string
  shopName: string | null
  categoryId: string | null
  categoryName: string | null
  sku: string
  name: string
  description: string | null
  priceSatang: number
  unit: string
  imageKey: string | null
  productType: ProductType
  maxPerOrder: number
  isActive: boolean
}

export function decorateProducts(
  rows: (typeof products.$inferSelect)[],
  db: Db = defaultDb()
): ProductView[] {
  if (rows.length === 0) return []

  const shopNames = new Map(
    db
      .select({ id: shops.id, name: shops.name })
      .from(shops)
      .where(inArray(shops.id, [...new Set(rows.map((r) => r.shopId))]))
      .all()
      .map((r) => [r.id, r.name])
  )

  const categoryIds = rows.map((r) => r.categoryId).filter((v): v is string => v !== null)
  const categoryNames = new Map(
    categoryIds.length === 0
      ? []
      : db
          .select({ id: categories.id, name: categories.name })
          .from(categories)
          .where(inArray(categories.id, categoryIds))
          .all()
          .map((r) => [r.id, r.name])
  )

  return rows.map((r) => ({
    id: r.id,
    shopId: r.shopId,
    shopName: shopNames.get(r.shopId) ?? null,
    categoryId: r.categoryId,
    categoryName: r.categoryId ? (categoryNames.get(r.categoryId) ?? null) : null,
    sku: r.sku,
    name: r.name,
    description: r.description,
    priceSatang: r.priceSatang,
    unit: r.unit,
    imageKey: r.imageKey,
    productType: r.productType,
    maxPerOrder: r.maxPerOrder,
    isActive: r.isActive
  }))
}
