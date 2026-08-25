import { describe, expect, it } from 'vitest'
import { BASE, loginCustomer, loginStaff, setupApp } from './helpers.js'

const ctx = setupApp()
const app = () => ctx.app

async function anyShop(prisonCode = 'KLP') {
  const { client } = await loginStaff(app())
  const prisons = (await client.json(`${BASE}/prisons`)) as any
  const prisonId = prisons.items.find((p: any) => p.code === prisonCode).id
  const shops = (await client.json(`${BASE}/shops?prisonId=${prisonId}`)) as any
  return { prisonId, shops: shops.items as any[] }
}

describe('catalog — public browsing', () => {
  it('lists shops with a live open/closed flag and a product count', async () => {
    const { shops } = await anyShop()
    expect(shops.length).toBe(2)
    const shop = shops.find((s) => s.shopType === 'vocational_training')
    expect(shop.productCount).toBeGreaterThan(0)
    expect(typeof shop.isOpenNow).toBe('boolean')
    expect(shop.zoneId).toBeNull()
  })

  it('falls back to the facility hours when a shop has none of its own', async () => {
    const { shops } = await anyShop()
    const res = (await (
      await loginCustomer(app())
    ).client.json(`${BASE}/shops/${shops[0].id}`)) as any
    expect(res.hours).toHaveLength(7)
    expect(res.hoursSource).toBe('prison')
    // The seeded facility default is closed on Sunday.
    expect(res.hours.find((h: any) => h.weekday === 0).isOpen).toBe(false)
  })

  it('returns only the categories a shop actually stocks', async () => {
    const { shops } = await anyShop()
    const voc = shops.find((s) => s.shopType === 'vocational_training')
    const { client } = await loginCustomer(app())

    const all = (await client.json(`${BASE}/categories`)) as any
    const scoped = (await client.json(`${BASE}/categories?shopId=${voc.id}`)) as any

    expect(all.items.length).toBe(5)
    expect(scoped.items.length).toBe(2)
    expect(scoped.items.every((c: any) => c.productCount > 0)).toBe(true)
  })

  it('paginates products by keyset and never repeats a row', async () => {
    const { shops } = await anyShop()
    const shop = shops.find((s) => s.shopType === 'prison_products')
    const { client } = await loginCustomer(app())

    const first = (await client.json(`${BASE}/products?shopId=${shop.id}&limit=4`)) as any
    expect(first.items).toHaveLength(4)
    expect(first.nextCursor).toBeTruthy()

    const second = (await client.json(
      `${BASE}/products?shopId=${shop.id}&limit=4&cursor=${encodeURIComponent(first.nextCursor)}`
    )) as any
    const ids = new Set([...first.items, ...second.items].map((p: any) => p.id))
    expect(ids.size).toBe(first.items.length + second.items.length)
  })

  it('rejects a malformed cursor instead of silently returning page one', async () => {
    const { shops } = await anyShop()
    const { client } = await loginCustomer(app())
    const res = await client.request(`${BASE}/products?shopId=${shops[0].id}&cursor=not-a-cursor`)
    expect(res.status).toBe(400)
  })
})

describe('catalog — administration', () => {
  it('keeps a prison_admin from creating a shop in another facility', async () => {
    const { client } = await loginStaff(app())
    const prisons = (await client.json(`${BASE}/prisons`)) as any
    const bkwId = prisons.items.find((p: any) => p.code === 'BKW').id

    const { client: klp } = await loginStaff(app(), 'klp.admin')
    const res = await klp.request(`${BASE}/admin/shops`, {
      method: 'POST',
      json: { prisonId: bkwId, name: 'ร้านทดสอบข้ามเรือนจำ' }
    })
    expect(res.status).toBe(403)
  })

  it('pins a new shop to the creator prison and rejects a duplicate name', async () => {
    const { client: klp } = await loginStaff(app(), 'klp.admin')
    const created = await klp.request(`${BASE}/admin/shops`, {
      method: 'POST',
      json: { name: 'ร้านทดสอบ', shopType: 'prison_products' }
    })
    expect(created.status).toBe(201)
    const shop = (await created.json()) as any
    expect(shop.prisonName).toContain('คลองเปรม')

    const again = await klp.request(`${BASE}/admin/shops`, {
      method: 'POST',
      json: { name: 'ร้านทดสอบ' }
    })
    expect(again.status).toBe(409)
  })

  it('refuses hours where closing is not after opening', async () => {
    const { shops } = await anyShop()
    const { client: klp } = await loginStaff(app(), 'klp.admin')
    const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      opensAt: '16:00',
      closesAt: '08:00',
      isOpen: true
    }))
    const res = await klp.request(`${BASE}/admin/shops/${shops[0].id}/hours`, {
      method: 'PUT',
      json: { hours }
    })
    expect(res.status).toBe(400)
  })

  it('stores shop hours and reports them as the shop own schedule', async () => {
    const { shops } = await anyShop()
    const { client: klp } = await loginStaff(app(), 'klp.admin')
    const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      opensAt: '09:00',
      closesAt: '15:00',
      isOpen: weekday !== 0 && weekday !== 6
    }))
    const res = (await klp.json(`${BASE}/admin/shops/${shops[1].id}/hours`, {
      method: 'PUT',
      json: { hours }
    })) as any
    expect(res.hoursSource).toBe('shop')
    expect(res.hours.find((h: any) => h.weekday === 6).isOpen).toBe(false)
  })

  it('keeps department-wide categories to super_admin', async () => {
    const { client: klp } = await loginStaff(app(), 'klp.admin')
    const denied = await klp.request(`${BASE}/admin/categories`, {
      method: 'POST',
      json: { name: 'หมวดหมู่ใหม่' }
    })
    expect(denied.status).toBe(403)

    const { client: sup } = await loginStaff(app())
    const ok = await sup.request(`${BASE}/admin/categories`, {
      method: 'POST',
      json: { name: 'หมวดหมู่ใหม่' }
    })
    expect(ok.status).toBe(201)
  })

  it('rejects a duplicate sku inside one shop', async () => {
    const { shops } = await anyShop()
    const { client: klp } = await loginStaff(app(), 'klp.admin')
    const body = {
      shopId: shops[0].id,
      sku: 'BEV-001',
      name: 'ของซ้ำ',
      priceSatang: 1000,
      unit: 'ชิ้น'
    }
    expect(
      (await klp.request(`${BASE}/admin/products`, { method: 'POST', json: body })).status
    ).toBe(409)
  })

  it('hides an inactive product from customers but keeps it for staff', async () => {
    const { shops } = await anyShop()
    const shop = shops.find((s) => s.shopType === 'vocational_training')
    const { client: klp } = await loginStaff(app(), 'klp.admin')

    const created = (await klp.json(`${BASE}/admin/products`, {
      method: 'POST',
      json: {
        shopId: shop.id,
        sku: 'VOC-999',
        name: 'สินค้าเลิกขาย',
        priceSatang: 5000,
        unit: 'ชิ้น',
        isActive: false
      }
    })) as any

    const { client: customer } = await loginCustomer(app())
    expect((await customer.request(`${BASE}/products/${created.id}`)).status).toBe(404)

    const staffList = (await klp.json(
      `${BASE}/admin/products?shopId=${shop.id}&includeInactive=true&limit=100`
    )) as any
    expect(staffList.items.some((p: any) => p.id === created.id)).toBe(true)
  })
})
