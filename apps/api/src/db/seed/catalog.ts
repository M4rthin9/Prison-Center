import type { Db } from '../client.js'
import { categories, products, shops } from '../schema/index.js'
import type { ProductType, ShopType } from '../schema/index.js'

/**
 * Catalog fixtures. Prices are realistic commissary prices in satang — the
 * whole point is that the order screens look like the real thing on day one.
 */

const CATEGORIES = [
  'เครื่องดื่ม',
  'ขนมและของว่าง',
  'อาหารแห้ง',
  'ของใช้ส่วนตัว',
  'ผลิตภัณฑ์งานฝีมือ'
]

interface SeedProduct {
  sku: string
  name: string
  category: string
  priceSatang: number
  unit: string
  productType: ProductType
  maxPerOrder?: number
}

interface SeedShop {
  name: string
  shopType: ShopType
  description: string
  products: SeedProduct[]
}

const SHOPS: SeedShop[] = [
  {
    name: 'ร้านค้าสงเคราะห์ผู้ต้องขัง',
    shopType: 'prison_products',
    description: 'สินค้าอุปโภคบริโภคประจำวันสำหรับผู้ต้องขัง',
    products: [
      {
        sku: 'BEV-001',
        name: 'กาแฟ 3in1 (ห่อ 20 ซอง)',
        category: 'เครื่องดื่ม',
        priceSatang: 8500,
        unit: 'ห่อ',
        productType: 'food_beverage',
        maxPerOrder: 5
      },
      {
        sku: 'BEV-002',
        name: 'โอวัลติน 3in1 (ห่อ 15 ซอง)',
        category: 'เครื่องดื่ม',
        priceSatang: 9000,
        unit: 'ห่อ',
        productType: 'food_beverage',
        maxPerOrder: 5
      },
      {
        sku: 'BEV-003',
        name: 'นมกล่อง UHT รสจืด 180 มล.',
        category: 'เครื่องดื่ม',
        priceSatang: 1400,
        unit: 'กล่อง',
        productType: 'food_beverage',
        maxPerOrder: 24
      },
      {
        sku: 'SNK-001',
        name: 'ขนมปังกรอบรสเนย',
        category: 'ขนมและของว่าง',
        priceSatang: 3500,
        unit: 'ห่อ',
        productType: 'packaged_goods'
      },
      {
        sku: 'SNK-002',
        name: 'ถั่วลิสงอบเกลือ 100 ก.',
        category: 'ขนมและของว่าง',
        priceSatang: 2500,
        unit: 'ห่อ',
        productType: 'packaged_goods'
      },
      {
        sku: 'DRY-001',
        name: 'บะหมี่กึ่งสำเร็จรูป (แพ็ก 6)',
        category: 'อาหารแห้ง',
        priceSatang: 4200,
        unit: 'แพ็ก',
        productType: 'food_beverage',
        maxPerOrder: 4
      },
      {
        sku: 'DRY-002',
        name: 'ปลากระป๋องซอสมะเขือเทศ',
        category: 'อาหารแห้ง',
        priceSatang: 2200,
        unit: 'กระป๋อง',
        productType: 'food_beverage',
        maxPerOrder: 12
      },
      {
        sku: 'PSN-001',
        name: 'สบู่ก้อน 70 ก.',
        category: 'ของใช้ส่วนตัว',
        priceSatang: 1800,
        unit: 'ก้อน',
        productType: 'packaged_goods'
      },
      {
        sku: 'PSN-002',
        name: 'ยาสีฟัน 80 ก.',
        category: 'ของใช้ส่วนตัว',
        priceSatang: 4500,
        unit: 'หลอด',
        productType: 'packaged_goods'
      },
      {
        sku: 'PSN-003',
        name: 'ผงซักฟอก 400 ก.',
        category: 'ของใช้ส่วนตัว',
        priceSatang: 3800,
        unit: 'ถุง',
        productType: 'packaged_goods'
      }
    ]
  },
  {
    name: 'ร้านค้าฝึกอาชีพผู้ต้องขัง',
    shopType: 'vocational_training',
    description: 'ผลิตภัณฑ์จากกองงานฝึกวิชาชีพภายในเรือนจำ',
    products: [
      {
        sku: 'VOC-001',
        name: 'ขนมปังเนยสด (กองงานเบเกอรี่)',
        category: 'ขนมและของว่าง',
        priceSatang: 3000,
        unit: 'ถุง',
        productType: 'food_beverage',
        maxPerOrder: 6
      },
      {
        sku: 'VOC-002',
        name: 'คุกกี้เนยกล่องเล็ก',
        category: 'ขนมและของว่าง',
        priceSatang: 6500,
        unit: 'กล่อง',
        productType: 'food_beverage'
      },
      {
        sku: 'VOC-003',
        name: 'กระเป๋าผ้าทอมือ',
        category: 'ผลิตภัณฑ์งานฝีมือ',
        priceSatang: 25000,
        unit: 'ใบ',
        productType: 'packaged_goods',
        maxPerOrder: 2
      },
      {
        sku: 'VOC-004',
        name: 'ผ้าขาวม้าทอมือ',
        category: 'ผลิตภัณฑ์งานฝีมือ',
        priceSatang: 18000,
        unit: 'ผืน',
        productType: 'packaged_goods',
        maxPerOrder: 3
      },
      {
        sku: 'VOC-005',
        name: 'ตะกร้าสานพลาสติก',
        category: 'ผลิตภัณฑ์งานฝีมือ',
        priceSatang: 12000,
        unit: 'ใบ',
        productType: 'packaged_goods',
        maxPerOrder: 3
      }
    ]
  }
]

export interface SeededCatalog {
  categories: number
  shops: number
  products: number
  /** prison code → shop ids, in the order declared above. */
  shopIdsByPrison: Record<string, string[]>
  /** shop id → product ids, in the order declared above. */
  productIdsByShop: Record<string, string[]>
}

export function seedCatalog(db: Db, prisonIds: Record<string, string>): SeededCatalog {
  const categoryIds = new Map(
    CATEGORIES.map((name, i) => [
      name,
      db.insert(categories).values({ name, sortOrder: i }).returning({ id: categories.id }).get().id
    ])
  )

  const shopIdsByPrison: Record<string, string[]> = {}
  const productIdsByShop: Record<string, string[]> = {}
  let productCount = 0

  for (const [code, prisonId] of Object.entries(prisonIds)) {
    shopIdsByPrison[code] = []

    for (const [i, s] of SHOPS.entries()) {
      // zoneId stays null: both seeded shops serve every แดน in the facility.
      const shopId = db
        .insert(shops)
        .values({
          prisonId,
          name: s.name,
          shopType: s.shopType,
          description: s.description,
          sortOrder: i
        })
        .returning({ id: shops.id })
        .get().id
      shopIdsByPrison[code]!.push(shopId)
      productIdsByShop[shopId] = []

      for (const p of s.products) {
        const productId = db
          .insert(products)
          .values({
            shopId,
            categoryId: categoryIds.get(p.category) ?? null,
            sku: p.sku,
            name: p.name,
            priceSatang: p.priceSatang,
            unit: p.unit,
            productType: p.productType,
            maxPerOrder: p.maxPerOrder ?? 0
          })
          .returning({ id: products.id })
          .get().id
        productIdsByShop[shopId]!.push(productId)
        productCount++
      }
    }
  }

  return {
    categories: categoryIds.size,
    shops: Object.values(shopIdsByPrison).flat().length,
    products: productCount,
    shopIdsByPrison,
    productIdsByShop
  }
}
