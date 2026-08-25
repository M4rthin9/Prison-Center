import { z } from 'zod'
import { Ulid } from './common.js'

/** ร้านค้าฝึกอาชีพฯ / ผลิตภัณฑ์ราชทัณฑ์ */
export const ShopType = z.enum(['vocational_training', 'prison_products'])
export type ShopType = z.infer<typeof ShopType>

/** สินค้าบรรจุภัณฑ์ / อาหาร&เครื่องดื่ม */
export const ProductType = z.enum(['packaged_goods', 'food_beverage'])
export type ProductType = z.infer<typeof ProductType>

export const SHOP_TYPE_LABEL: Record<ShopType, string> = {
  vocational_training: 'ร้านค้าฝึกอาชีพฯ',
  prison_products: 'ผลิตภัณฑ์ราชทัณฑ์'
}

export const PRODUCT_TYPE_LABEL: Record<ProductType, string> = {
  packaged_goods: 'สินค้าบรรจุภัณฑ์',
  food_beverage: 'อาหารและเครื่องดื่ม'
}

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'ต้องเป็นรูปแบบ HH:MM')

export const ShopHour = z.object({
  /** 0 = อาทิตย์ */
  weekday: z.number().int().min(0).max(6),
  opensAt: HHMM,
  closesAt: HHMM,
  isOpen: z.boolean()
})
export type ShopHour = z.infer<typeof ShopHour>

export const ShopSummary = z.object({
  id: Ulid,
  prisonId: Ulid,
  prisonName: z.string().nullable(),
  /** null == ทุกแดน */
  zoneId: Ulid.nullable(),
  zoneName: z.string().nullable(),
  name: z.string(),
  shopType: ShopType,
  description: z.string().nullable(),
  imageKey: z.string().nullable(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  /** Evaluated server-side in Asia/Bangkok — the client never guesses. */
  isOpenNow: z.boolean(),
  productCount: z.number().int()
})
export type ShopSummary = z.infer<typeof ShopSummary>

export const ShopDetail = ShopSummary.extend({
  /** Falls back to the facility-wide `shop.hours` setting when unset. */
  hours: z.array(ShopHour),
  hoursSource: z.enum(['shop', 'prison'])
})
export type ShopDetail = z.infer<typeof ShopDetail>

export const Category = z.object({
  id: Ulid,
  name: z.string(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
  productCount: z.number().int().optional()
})
export type Category = z.infer<typeof Category>

export const Product = z.object({
  id: Ulid,
  shopId: Ulid,
  shopName: z.string().nullable(),
  categoryId: Ulid.nullable(),
  categoryName: z.string().nullable(),
  sku: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  priceSatang: z.number().int(),
  unit: z.string(),
  imageKey: z.string().nullable(),
  productType: ProductType,
  /** 0 == ไม่จำกัดต่อคำสั่งซื้อ */
  maxPerOrder: z.number().int(),
  isActive: z.boolean()
})
export type Product = z.infer<typeof Product>

/* ── admin inputs ──────────────────────────────────────────────────────── */

export const CreateShopInput = z.object({
  prisonId: Ulid.optional(),
  zoneId: Ulid.nullable().optional(),
  name: z.string().min(1, 'ต้องระบุชื่อร้าน').max(120),
  shopType: ShopType.default('prison_products'),
  description: z.string().max(500).nullable().optional(),
  sortOrder: z.number().int().min(0).max(999).optional(),
  isActive: z.boolean().optional()
})
export type CreateShopInput = z.infer<typeof CreateShopInput>

export const UpdateShopInput = CreateShopInput.partial().omit({ prisonId: true })
export type UpdateShopInput = z.infer<typeof UpdateShopInput>

export const ShopHoursInput = z.object({ hours: z.array(ShopHour).length(7) })
export type ShopHoursInput = z.infer<typeof ShopHoursInput>

export const CreateCategoryInput = z.object({
  name: z.string().min(1, 'ต้องระบุชื่อหมวดหมู่').max(80),
  sortOrder: z.number().int().min(0).max(999).optional(),
  isActive: z.boolean().optional()
})
export type CreateCategoryInput = z.infer<typeof CreateCategoryInput>

export const UpdateCategoryInput = CreateCategoryInput.partial()
export type UpdateCategoryInput = z.infer<typeof UpdateCategoryInput>

export const CreateProductInput = z.object({
  shopId: Ulid,
  categoryId: Ulid.nullable().optional(),
  sku: z.string().min(1, 'ต้องระบุรหัสสินค้า').max(40),
  name: z.string().min(1, 'ต้องระบุชื่อสินค้า').max(160),
  description: z.string().max(1000).nullable().optional(),
  /** Satang. The client sends integers; baht never crosses the wire. */
  priceSatang: z.number().int().min(0).max(10_000_000),
  unit: z.string().min(1).max(20).default('ชิ้น'),
  productType: ProductType.default('packaged_goods'),
  maxPerOrder: z.number().int().min(0).max(999).optional(),
  isActive: z.boolean().optional()
})
export type CreateProductInput = z.infer<typeof CreateProductInput>

export const UpdateProductInput = CreateProductInput.partial().omit({ shopId: true })
export type UpdateProductInput = z.infer<typeof UpdateProductInput>
