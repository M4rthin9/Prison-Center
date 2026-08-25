import { describe, expect, it } from 'vitest'
import { BASE, loginCustomer, loginStaff, setupApp } from './helpers.js'

const ctx = setupApp()
const app = () => ctx.app

/** The seeded relative with two verified links, both at คลองเปรม. */
async function relative() {
  const { client } = await loginCustomer(app())
  const me = (await client.json(`${BASE}/me`)) as any
  const verified = me.inmates.filter((i: any) => i.verifyStatus === 'verified')
  return { client, me, inmate: verified[0], secondInmate: verified[1] }
}

async function shopWithProducts(prisonId: string, type = 'prison_products') {
  const { client } = await loginCustomer(app())
  const shops = (await client.json(`${BASE}/shops?prisonId=${prisonId}`)) as any
  const shop = shops.items.find((s: any) => s.shopType === type)
  const products = (await client.json(`${BASE}/products?shopId=${shop.id}&limit=100`)) as any
  return { shop, products: products.items as any[] }
}

describe('placing an order', () => {
  it('prices the cart from the database and numbers it {CODE}-{YYMM}-{SEQ}', async () => {
    const { client, inmate } = await relative()
    const { shop, products } = await shopWithProducts(inmate.prisonId)
    const [a, b] = products

    const res = await client.request(`${BASE}/orders`, {
      method: 'POST',
      json: {
        inmateId: inmate.inmateId,
        shopId: shop.id,
        items: [
          { productId: a.id, qty: 2 },
          { productId: b.id, qty: 1 }
        ],
        note: 'ทดสอบ'
      }
    })
    expect(res.status).toBe(201)
    const order = (await res.json()) as any

    expect(order.orderNo).toMatch(/^KLP-\d{4}-\d{4}$/)
    expect(order.paymentStatus).toBe('unpaid')
    expect(order.fulfillmentStatus).toBe('new')
    expect(order.subtotalSatang).toBe(a.priceSatang * 2 + b.priceSatang)
    expect(order.totalSatang).toBe(order.subtotalSatang)
    expect(order.itemCount).toBe(3)
    // Snapshots, not live joins.
    expect(order.items[0].name).toBe(a.name)
    expect(order.items[0].unitPriceSatang).toBe(a.priceSatang)
    expect(order.inmateName).toBe(inmate.fullName)
    expect(order.zoneName).toBe(inmate.zoneName)
  })

  it('gives every order in a facility its own number', async () => {
    const { client, inmate } = await relative()
    const { shop, products } = await shopWithProducts(inmate.prisonId)

    const numbers: string[] = []
    for (let i = 0; i < 3; i++) {
      const order = (await client.json(`${BASE}/orders`, {
        method: 'POST',
        json: {
          inmateId: inmate.inmateId,
          shopId: shop.id,
          items: [{ productId: products[0].id, qty: 1 }]
        }
      })) as any
      numbers.push(order.orderNo)
    }
    expect(new Set(numbers).size).toBe(3)

    const seqs = numbers.map((n) => Number(n.split('-')[2]))
    expect(seqs[1]).toBe(seqs[0]! + 1)
    expect(seqs[2]).toBe(seqs[1]! + 1)
  })

  it('merges the same product appearing twice in one cart', async () => {
    const { client, inmate } = await relative()
    const { shop, products } = await shopWithProducts(inmate.prisonId)
    const p = products[0]

    const order = (await client.json(`${BASE}/orders`, {
      method: 'POST',
      json: {
        inmateId: inmate.inmateId,
        shopId: shop.id,
        items: [
          { productId: p.id, qty: 1 },
          { productId: p.id, qty: 2 }
        ]
      }
    })) as any

    expect(order.items).toHaveLength(1)
    expect(order.items[0].qty).toBe(3)
    expect(order.totalSatang).toBe(p.priceSatang * 3)
  })

  it('refuses an order against an unverified link', async () => {
    const { client } = await loginCustomer(app(), '0845678901')
    const me = (await client.json(`${BASE}/me`)) as any
    const pending = me.inmates[0]
    expect(pending.verifyStatus).toBe('pending')

    const { shop, products } = await shopWithProducts(pending.prisonId)
    const res = await client.request(`${BASE}/orders`, {
      method: 'POST',
      json: {
        inmateId: pending.inmateId,
        shopId: shop.id,
        items: [{ productId: products[0].id, qty: 1 }]
      }
    })
    expect(res.status).toBe(403)
  })

  it('refuses an inmate the relative is not linked to at all', async () => {
    const { client } = await relative()
    const { client: other } = await loginCustomer(app(), '0834567890')
    const otherMe = (await other.json(`${BASE}/me`)) as any
    const strangerInmate = otherMe.inmates[0]

    const { shop, products } = await shopWithProducts(strangerInmate.prisonId)
    const res = await client.request(`${BASE}/orders`, {
      method: 'POST',
      json: {
        inmateId: strangerInmate.inmateId,
        shopId: shop.id,
        items: [{ productId: products[0].id, qty: 1 }]
      }
    })
    expect(res.status).toBe(403)
  })

  it('refuses a shop that belongs to a different facility', async () => {
    const { client, inmate } = await relative()
    const { client: staff } = await loginStaff(app())
    const prisons = (await staff.json(`${BASE}/prisons`)) as any
    const bkwId = prisons.items.find((p: any) => p.code === 'BKW').id
    const { shop, products } = await shopWithProducts(bkwId)

    const res = await client.request(`${BASE}/orders`, {
      method: 'POST',
      json: {
        inmateId: inmate.inmateId,
        shopId: shop.id,
        items: [{ productId: products[0].id, qty: 1 }]
      }
    })
    expect(res.status).toBe(400)
  })

  it('refuses a product from another shop and a quantity over the per-order cap', async () => {
    const { client, inmate } = await relative()
    const { shop } = await shopWithProducts(inmate.prisonId)
    const other = await shopWithProducts(inmate.prisonId, 'vocational_training')

    const mixed = await client.request(`${BASE}/orders`, {
      method: 'POST',
      json: {
        inmateId: inmate.inmateId,
        shopId: shop.id,
        items: [{ productId: other.products[0].id, qty: 1 }]
      }
    })
    expect(mixed.status).toBe(400)

    const capped = other.products.find((p: any) => p.maxPerOrder > 0)
    const overCap = await client.request(`${BASE}/orders`, {
      method: 'POST',
      json: {
        inmateId: inmate.inmateId,
        shopId: other.shop.id,
        items: [{ productId: capped.id, qty: capped.maxPerOrder + 1 }]
      }
    })
    expect(overCap.status).toBe(400)
  })

  it('rejects an empty cart and a zero quantity before any pricing happens', async () => {
    const { client, inmate } = await relative()
    const { shop, products } = await shopWithProducts(inmate.prisonId)

    expect(
      (
        await client.request(`${BASE}/orders`, {
          method: 'POST',
          json: { inmateId: inmate.inmateId, shopId: shop.id, items: [] }
        })
      ).status
    ).toBe(422)

    expect(
      (
        await client.request(`${BASE}/orders`, {
          method: 'POST',
          json: {
            inmateId: inmate.inmateId,
            shopId: shop.id,
            items: [{ productId: products[0].id, qty: 0 }]
          }
        })
      ).status
    ).toBe(422)
  })
})

describe('order history', () => {
  it('shows the relative only their own orders, newest first', async () => {
    const { client } = await relative()
    const page = (await client.json(`${BASE}/orders?limit=5`)) as any
    expect(page.items.length).toBeGreaterThan(0)

    const times = page.items.map((o: any) => o.orderedAt)
    expect([...times].sort((a, b) => b - a)).toEqual(times)

    const { client: other } = await loginCustomer(app(), '0834567890')
    const otherPage = (await other.json(`${BASE}/orders`)) as any
    const mine = new Set(page.items.map((o: any) => o.id))
    expect(otherPage.items.every((o: any) => !mine.has(o.id))).toBe(true)
  })

  it('refuses to read someone else order by id', async () => {
    const { client } = await relative()
    const page = (await client.json(`${BASE}/orders?limit=1`)) as any
    const orderId = page.items[0].id

    const { client: other } = await loginCustomer(app(), '0823456789')
    expect((await other.request(`${BASE}/orders/${orderId}`)).status).toBe(403)
  })
})

describe('order administration', () => {
  async function anOrder() {
    const { client, inmate } = await relative()
    const { shop, products } = await shopWithProducts(inmate.prisonId)
    return (await client.json(`${BASE}/orders`, {
      method: 'POST',
      json: {
        inmateId: inmate.inmateId,
        shopId: shop.id,
        items: [{ productId: products[0].id, qty: 1 }]
      }
    })) as any
  }

  it('scopes the admin list to the caller facility', async () => {
    await anOrder()
    const { client: klp } = await loginStaff(app(), 'klp.admin')
    const { client: bkw } = await loginStaff(app(), 'bkw.admin')

    const klpPage = (await klp.json(`${BASE}/admin/orders?limit=100`)) as any
    expect(klpPage.items.length).toBeGreaterThan(0)
    expect(klpPage.items.every((o: any) => o.prisonName.includes('คลองเปรม'))).toBe(true)

    const bkwPage = (await bkw.json(`${BASE}/admin/orders?limit=100`)) as any
    const klpIds = new Set(klpPage.items.map((o: any) => o.id))
    expect(bkwPage.items.every((o: any) => !klpIds.has(o.id))).toBe(true)
  })

  it('refuses a cross-prison read of one order', async () => {
    const order = await anOrder()
    const { client: bkw } = await loginStaff(app(), 'bkw.admin')
    expect((await bkw.request(`${BASE}/admin/orders/${order.id}`)).status).toBe(403)
  })

  it('walks new → preparing → delivered and refuses to walk back', async () => {
    const order = await anOrder()
    const { client: klp } = await loginStaff(app(), 'klp.admin')

    const preparing = (await klp.json(`${BASE}/admin/orders/${order.id}/fulfillment`, {
      method: 'PATCH',
      json: { status: 'preparing' }
    })) as any
    expect(preparing.fulfillmentStatus).toBe('preparing')

    const delivered = (await klp.json(`${BASE}/admin/orders/${order.id}/fulfillment`, {
      method: 'PATCH',
      json: { status: 'delivered' }
    })) as any
    expect(delivered.fulfillmentStatus).toBe('delivered')
    expect(delivered.fulfilledAt).toBeGreaterThan(0)

    const back = await klp.request(`${BASE}/admin/orders/${order.id}/fulfillment`, {
      method: 'PATCH',
      json: { status: 'preparing' }
    })
    expect(back.status).toBe(409)
  })

  it('requires a reason to cancel, and keeps the reason on the order', async () => {
    const order = await anOrder()
    const { client: klp } = await loginStaff(app(), 'klp.admin')

    const noReason = await klp.request(`${BASE}/admin/orders/${order.id}/fulfillment`, {
      method: 'PATCH',
      json: { status: 'cancelled' }
    })
    expect(noReason.status).toBe(400)

    const cancelled = (await klp.json(`${BASE}/admin/orders/${order.id}/fulfillment`, {
      method: 'PATCH',
      json: { status: 'cancelled', reason: 'สินค้าหมด' }
    })) as any
    expect(cancelled.fulfillmentStatus).toBe('cancelled')
    expect(cancelled.cancelReason).toBe('สินค้าหมด')
  })

  it('lets zone staff fulfil but not the finance role', async () => {
    const order = await anOrder()
    const { client: finance } = await loginStaff(app(), 'klp.finance')
    expect(
      (
        await finance.request(`${BASE}/admin/orders/${order.id}/fulfillment`, {
          method: 'PATCH',
          json: { status: 'preparing' }
        })
      ).status
    ).toBe(403)

    const { client: zone } = await loginStaff(app(), 'klp.zone')
    expect(
      (
        await zone.request(`${BASE}/admin/orders/${order.id}/fulfillment`, {
          method: 'PATCH',
          json: { status: 'preparing' }
        })
      ).status
    ).toBe(200)
  })

  it('leaves a placed order untouched when the product price is edited afterwards', async () => {
    const order = await anOrder()
    const line = order.items[0]

    const { client: klp } = await loginStaff(app(), 'klp.admin')
    await klp.request(`${BASE}/admin/products/${line.productId}`, {
      method: 'PATCH',
      json: { priceSatang: line.unitPriceSatang + 5000 }
    })

    const after = (await klp.json(`${BASE}/admin/orders/${order.id}`)) as any
    expect(after.items[0].unitPriceSatang).toBe(line.unitPriceSatang)
    expect(after.totalSatang).toBe(order.totalSatang)
  })
})
