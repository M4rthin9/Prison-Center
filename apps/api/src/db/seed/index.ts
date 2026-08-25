import { sql } from 'drizzle-orm'
import { createDb, runMigrations, type Db } from '../client.js'
import { env } from '../../env.js'
import {
  categories,
  counters,
  customerInmates,
  customers,
  inmates,
  orderItems,
  orders,
  prisons,
  products,
  shopHours,
  shops,
  staff,
  workDivisions,
  zones
} from '../schema/index.js'
import { hashPassword } from '../../lib/password.js'
import { setSetting } from '../../modules/settings/service.js'
import { placeOrder } from '../../modules/orders/service.js'
import { seedCatalog } from './catalog.js'
import { seedPaymentChannels } from './payments.js'

/**
 * Dev fixtures. Deterministic and idempotent: running it twice leaves the same
 * two prisons, not four. Passwords are trivial on purpose — this data must
 * never reach a production box (guarded below).
 */

const DEV_PASSWORD = 'password123'

interface SeedPrison {
  code: string
  nameTh: string
  nameEn: string
  province: string
  phone: string
  address: string
  zones: string[]
  divisions: string[]
}

const PRISONS: SeedPrison[] = [
  {
    code: 'KLP',
    nameTh: 'เรือนจำกลางคลองเปรม',
    nameEn: 'Klong Prem Central Prison',
    province: 'กรุงเทพมหานคร',
    phone: '02-953-3999',
    address: '33/2 ถนนงามวงศ์วาน แขวงลาดยาว เขตจตุจักร กรุงเทพมหานคร 10900',
    zones: ['แดน 1', 'แดน 2', 'แดน 3', 'แดน 6', 'แดน 7', 'แดน 10'],
    divisions: ['กองงานเบเกอรี่', 'กองงานตัดเย็บ', 'กองงานเฟอร์นิเจอร์']
  },
  {
    code: 'BKW',
    nameTh: 'เรือนจำกลางบางขวาง',
    nameEn: 'Bang Kwang Central Prison',
    province: 'นนทบุรี',
    phone: '02-525-0475',
    address: '38 หมู่ 4 ถนนนนทบุรี 1 ตำบลสวนใหญ่ อำเภอเมือง นนทบุรี 11000',
    zones: ['แดน 1', 'แดน 2', 'แดน 4', 'แดน 5'],
    divisions: ['กองงานหัตถกรรม', 'กองงานเกษตร']
  }
]

const THAI_FIRST = [
  'สมชาย',
  'ประเสริฐ',
  'วิชัย',
  'อนุชา',
  'ธนากร',
  'ภาคภูมิ',
  'ณัฐพล',
  'กิตติศักดิ์',
  'ศราวุธ',
  'พงศกร'
]
const THAI_LAST = [
  'ใจดี',
  'ศรีสุข',
  'บุญมา',
  'ทองคำ',
  'แสงทอง',
  'พัฒนา',
  'รุ่งเรือง',
  'สมบูรณ์',
  'วงศ์ไทย',
  'มั่นคง'
]

function seedInmateName(i: number) {
  return `${THAI_FIRST[i % THAI_FIRST.length]} ${THAI_LAST[(i * 3) % THAI_LAST.length]}`
}

export async function seed(db: Db) {
  const hash = await hashPassword(DEV_PASSWORD)

  const existing =
    db
      .select({ n: sql<number>`count(*)` })
      .from(prisons)
      .get()?.n ?? 0
  if (existing > 0) {
    console.log('• database already seeded — clearing dev data first')
    db.delete(orderItems).run()
    db.delete(orders).run()
    db.delete(counters).run()
    db.delete(products).run()
    db.delete(shopHours).run()
    db.delete(shops).run()
    db.delete(categories).run()
    db.delete(customerInmates).run()
    db.delete(customers).run()
    db.delete(staff).run()
    db.delete(inmates).run()
    db.delete(workDivisions).run()
    db.delete(zones).run()
    db.delete(prisons).run()
  }

  const prisonIds: Record<string, string> = {}
  const zoneIds: Record<string, string[]> = {}
  const divisionIds: Record<string, string[]> = {}

  for (const p of PRISONS) {
    const prison = db
      .insert(prisons)
      .values({
        code: p.code,
        nameTh: p.nameTh,
        nameEn: p.nameEn,
        province: p.province,
        phone: p.phone,
        address: p.address
      })
      .returning()
      .get()
    prisonIds[p.code] = prison.id

    zoneIds[p.code] = p.zones.map(
      (name, i) =>
        db
          .insert(zones)
          .values({ prisonId: prison.id, name, code: `Z${i + 1}`, sortOrder: i })
          .returning()
          .get().id
    )

    divisionIds[p.code] = p.divisions.map(
      (name, i) =>
        db
          .insert(workDivisions)
          .values({ prisonId: prison.id, name, code: `WD${i + 1}` })
          .returning()
          .get().id
    )
  }

  // 20 inmates spread across both facilities, all carrying a DOC-shaped
  // external id so the Phase 0b importer has something realistic to match.
  const inmateIds: string[] = []
  let n = 0
  for (const p of PRISONS) {
    const zoneList = zoneIds[p.code]!
    const divisionList = divisionIds[p.code]!
    for (let i = 0; i < 10; i++, n++) {
      const id = db
        .insert(inmates)
        .values({
          prisonId: prisonIds[p.code]!,
          zoneId: zoneList[i % zoneList.length]!,
          workDivisionId: divisionList[i % divisionList.length]!,
          inmateCode: `${p.code}-68-${String(i + 1).padStart(4, '0')}`,
          fullName: seedInmateName(n),
          status: 'active',
          externalSource: 'doc_xlsx',
          externalId: `${p.code}${String(i + 1).padStart(6, '0')}`,
          syncedAt: Date.now(),
          syncHash: null
        })
        .returning({ id: inmates.id })
        .get().id
      inmateIds.push(id)
    }
  }

  /* ── staff ──────────────────────────────────────────────────────────── */

  const staffSeed = [
    {
      username: 'superadmin',
      fullName: 'ผู้ดูแลระบบส่วนกลาง',
      role: 'super_admin' as const,
      prison: null
    },
    {
      username: 'klp.admin',
      fullName: 'ผู้ดูแลเรือนจำคลองเปรม',
      role: 'prison_admin' as const,
      prison: 'KLP'
    },
    {
      username: 'klp.finance',
      fullName: 'การเงิน คลองเปรม',
      role: 'finance' as const,
      prison: 'KLP'
    },
    {
      username: 'klp.letters',
      fullName: 'งานจดหมาย คลองเปรม',
      role: 'letter_operator' as const,
      prison: 'KLP'
    },
    {
      username: 'klp.zone',
      fullName: 'เจ้าหน้าที่แดน คลองเปรม',
      role: 'zone_staff' as const,
      prison: 'KLP'
    },
    {
      username: 'bkw.admin',
      fullName: 'ผู้ดูแลเรือนจำบางขวาง',
      role: 'prison_admin' as const,
      prison: 'BKW'
    }
  ]

  for (const s of staffSeed) {
    db.insert(staff)
      .values({
        username: s.username,
        fullName: s.fullName,
        role: s.role,
        prisonId: s.prison ? prisonIds[s.prison]! : null,
        passwordHash: hash,
        // Seeded accounts skip the forced change so `pnpm dev` is usable
        // immediately. Real accounts are created with mustChangePassword = 1.
        mustChangePassword: false,
        passwordChangedAt: Date.now()
      })
      .run()
  }

  /* ── customers (ญาติ) ───────────────────────────────────────────────── */

  const customerSeed = [
    { phone: '0812345678', fullName: 'สมหญิง ใจดี', links: [0, 1], verify: 'verified' as const },
    { phone: '0823456789', fullName: 'มาลี ศรีสุข', links: [2], verify: 'verified' as const },
    { phone: '0834567890', fullName: 'วันเพ็ญ บุญมา', links: [10], verify: 'verified' as const },
    { phone: '0845678901', fullName: 'ประนอม ทองคำ', links: [3], verify: 'pending' as const },
    { phone: '0856789012', fullName: 'สุดา แสงทอง', links: [], verify: 'pending' as const }
  ]

  const customerIds: Record<string, string> = {}
  for (const cst of customerSeed) {
    const row = db
      .insert(customers)
      .values({
        username: cst.phone,
        phone: cst.phone,
        fullName: cst.fullName,
        passwordHash: hash,
        mustChangePassword: false,
        passwordChangedAt: Date.now()
      })
      .returning()
      .get()
    customerIds[cst.phone] = row.id

    for (const idx of cst.links) {
      db.insert(customerInmates)
        .values({
          customerId: row.id,
          inmateId: inmateIds[idx]!,
          relationship: 'ญาติ',
          verifyStatus: cst.verify,
          verifiedAt: cst.verify === 'verified' ? Date.now() : null
        })
        .run()
    }
  }

  /* ── catalog (เฟส 1) ────────────────────────────────────────────────── */

  const catalog = seedCatalog(db, prisonIds)

  /* ── payment channels (เฟส 2) ───────────────────────────────────────── */

  const paymentSeed = seedPaymentChannels(db, prisonIds)

  /* ── two orders, placed through the real service ────────────────────── */

  // Going through placeOrder rather than inserting rows keeps the fixtures
  // honest: they are numbered, priced and validated exactly like a real order.
  const klpShop = catalog.shopIdsByPrison['KLP']![0]!
  const klpProducts = catalog.productIdsByShop[klpShop]!
  const vocShop = catalog.shopIdsByPrison['KLP']![1]!
  const vocProducts = catalog.productIdsByShop[vocShop]!

  const seededOrders = [
    placeOrder(
      customerIds['0812345678']!,
      {
        inmateId: inmateIds[0]!,
        shopId: klpShop,
        items: [
          { productId: klpProducts[0]!, qty: 2 },
          { productId: klpProducts[7]!, qty: 3 },
          { productId: klpProducts[6]!, qty: 4 }
        ],
        note: 'ฝากส่งช่วงเช้า'
      },
      {},
      db
    ),
    placeOrder(
      customerIds['0812345678']!,
      {
        inmateId: inmateIds[1]!,
        shopId: vocShop,
        items: [
          { productId: vocProducts[0]!, qty: 2 },
          { productId: vocProducts[2]!, qty: 1 }
        ]
      },
      {},
      db
    )
  ]

  /* ── per-prison settings overrides ──────────────────────────────────── */

  for (const p of PRISONS) {
    setSetting('contact.phone', p.phone, { prisonId: prisonIds[p.code]!, db })
    setSetting('contact.address_th', p.address, { prisonId: prisonIds[p.code]!, db })
  }

  return {
    prisons: PRISONS.length,
    zones: Object.values(zoneIds).flat().length,
    inmates: inmateIds.length,
    staff: staffSeed.length,
    customers: customerSeed.length,
    categories: catalog.categories,
    shops: catalog.shops,
    products: catalog.products,
    paymentChannels: paymentSeed.channels,
    orders: seededOrders.length
  }
}

async function main() {
  const e = env()
  if (e.isProd) throw new Error('refusing to seed dev fixtures with NODE_ENV=production')

  const { db, sqlite } = createDb(e.paths.database)
  runMigrations(db)
  const counts = await seed(db)
  sqlite.close()

  console.log('✓ seeded', counts)
  console.log('')
  console.log('  ญาติผู้ต้องขัง (customer app :5173)')
  console.log(`    0812345678 / ${DEV_PASSWORD}   ← ผูกกับผู้ต้องขัง 2 คน (ยืนยันแล้ว)`)
  console.log(`    0845678901 / ${DEV_PASSWORD}   ← คำขอผูกบัญชียังไม่ได้รับการยืนยัน`)
  console.log('')
  console.log('  เจ้าหน้าที่ (admin dashboard :5174)')
  console.log(`    superadmin / ${DEV_PASSWORD}   ← ทุกเรือนจำ`)
  console.log(`    klp.admin  / ${DEV_PASSWORD}   ← เฉพาะคลองเปรม`)
  console.log(`    bkw.admin  / ${DEV_PASSWORD}   ← เฉพาะบางขวาง`)
}

// Only run when invoked directly (`pnpm db:seed`), not when imported by tests.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\\/]/).pop() ?? '')) {
  await main()
}
