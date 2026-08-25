import { beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { BASE, loginCustomer, loginStaff, setupApp, type TestClient } from './helpers.js'

const ctx = setupApp()
const app = () => ctx.app

const { buildSlipMiniQr } = await import('../src/lib/payments/promptpay.js')
const { qrPngBuffer } = await import('../src/lib/payments/slip.js')
const { setStorage } = await import('../src/lib/storage/index.js')
const { setSetting } = await import('../src/modules/settings/service.js')
const { db } = await import('../src/db/client.js')

/** Slips never touch the disk in a test run. */
beforeAll(() => {
  const files = new Map<string, Buffer>()
  let n = 0
  setStorage({
    kind: 'local',
    async put(body, opts) {
      const key = `${opts?.prefix ?? 'misc'}/test-${++n}.jpg`
      files.set(key, Buffer.from(body))
      return { key, size: body.byteLength, contentType: opts?.contentType ?? null, url: `/f/${key}` }
    },
    async get(key) {
      const f = files.get(key)
      if (!f) throw new Error(`missing ${key}`)
      return f
    },
    async delete(key) {
      files.delete(key)
    },
    async exists(key) {
      return files.has(key)
    },
    url: (key) => `/f/${key}`
  })
  // These tests deliberately leave deposits open; the per-inmate cap has its
  // own test and would otherwise fire everywhere else first.
  setSetting('deposit.max_open_per_inmate', 20, { db: db() })
})

/* ── fixtures ──────────────────────────────────────────────────────────── */

async function relative(username = '0812345678') {
  const { client } = await loginCustomer(app(), username)
  const me = (await client.json(`${BASE}/me`)) as any
  const inmate = me.inmates.find((i: any) => i.verifyStatus === 'verified')
  return { client, inmate, me }
}

const staffClient = async (username = 'klp.admin') =>
  (await loginStaff(app(), username)).client

let slipSeq = 0
const nextRef = () => `DEP${String(++slipSeq).padStart(9, '0')}`

async function slipImage(transRef: string, sendingBank = '004'): Promise<Buffer> {
  const qr = await qrPngBuffer(buildSlipMiniQr(sendingBank, transRef), 220)
  return sharp({ create: { width: 760, height: 1200, channels: 3, background: '#ffffff' } })
    .composite([{ input: qr, top: 900, left: 470 }])
    .jpeg({ quality: 92 })
    .toBuffer()
}

async function uploadSlip(client: TestClient, paymentId: string, image: Buffer) {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(image)], { type: 'image/jpeg' }), 'slip.jpg')
  return client.request(`${BASE}/payments/${paymentId}/slip`, { method: 'POST', body: form })
}

/** Card approved for this (relative, inmate) pair — the gate before any deposit. */
async function approvedCard(client: TestClient, inmateId: string) {
  const existing = ((await client.json(`${BASE}/deposit-cards`)) as any).items.find(
    (c: any) => c.inmateId === inmateId
  )
  const card =
    existing ??
    ((await client.json(`${BASE}/deposit-cards`, {
      method: 'POST',
      json: { inmateId }
    })) as any)
  if (card.status === 'approved') return card

  const admin = await staffClient('superadmin')
  return (await admin.json(`${BASE}/admin/deposit-cards/${card.id}/review`, {
    method: 'POST',
    json: { status: 'approved' }
  })) as any
}

async function makeDeposit(client: TestClient, inmateId: string, amountSatang = 50000) {
  return (await client.json(`${BASE}/deposits`, {
    method: 'POST',
    json: { inmateId, amountSatang }
  })) as any
}

/** Deposit → slip → staff verify. Leaves the deposit in `reviewing`. */
async function depositAndSettle(client: TestClient, inmateId: string, amountSatang = 50000) {
  const deposit = await makeDeposit(client, inmateId, amountSatang)
  const ref = nextRef()
  const res = await uploadSlip(client, deposit.payment.id, await slipImage(ref))
  expect(res.status).toBe(201)

  const admin = await staffClient('klp.finance')
  const verified = (await admin.json(`${BASE}/admin/payments/${deposit.payment.id}/verify`, {
    method: 'POST',
    json: {
      transRef: ref,
      transferAmountSatang: deposit.payment.chargeSatang,
      transferredAt: Date.now(),
      sendingBank: '004'
    }
  })) as any
  expect(verified.status).toBe('succeeded')
  return deposit
}

/* ── deposit cards ─────────────────────────────────────────────────────── */

describe('deposit cards', () => {
  it('requests a card, and staff approve it with a card number', async () => {
    const { client, inmate } = await relative('0834567890')
    const card = await approvedCard(client, inmate.inmateId)
    expect(card.status).toBe('approved')
    expect(card.cardNo).toMatch(/^BKW-C\d{4}-\d{4}$/)
    expect(card.approvedAt).not.toBeNull()
  })

  it('refuses a card for an inmate the account is not verified against', async () => {
    const { client } = await relative()
    const admin = await staffClient()
    const roster = (await admin.json(`${BASE}/admin/inmates?limit=100`)) as any
    const stranger = roster.items.at(-1)

    const res = await client.request(`${BASE}/deposit-cards`, {
      method: 'POST',
      json: { inmateId: stranger.id }
    })
    expect(res.status).toBe(403)
  })

  it('refuses a second request while one is pending or approved', async () => {
    const { client, inmate } = await relative()
    await approvedCard(client, inmate.inmateId)
    const res = await client.request(`${BASE}/deposit-cards`, {
      method: 'POST',
      json: { inmateId: inmate.inmateId }
    })
    expect(res.status).toBe(409)
  })

  it('keeps the same card number when a card is suspended and reinstated', async () => {
    const { client, inmate } = await relative('0834567890')
    const card = await approvedCard(client, inmate.inmateId)
    const admin = await staffClient('bkw.admin')
    expect(card.prisonName).toContain('บางขวาง')

    const suspended = (await admin.json(`${BASE}/admin/deposit-cards/${card.id}/review`, {
      method: 'POST',
      json: { status: 'suspended', reason: 'ตรวจสอบข้อมูลเพิ่มเติม' }
    })) as any
    expect(suspended.status).toBe('suspended')

    const back = (await admin.json(`${BASE}/admin/deposit-cards/${card.id}/review`, {
      method: 'POST',
      json: { status: 'approved' }
    })) as any
    expect(back.cardNo).toBe(card.cardNo)
  })

  it('scopes the card queue to the reviewing staff member’s facility', async () => {
    const bkw = await staffClient('bkw.admin')
    const queue = (await bkw.json(`${BASE}/admin/deposit-cards?status=approved`)) as any
    expect(queue.items.every((c: any) => c.prisonName.includes('บางขวาง'))).toBe(true)
  })
})

/* ── the deposit flow ──────────────────────────────────────────────────── */

describe('deposits', () => {
  it('creates a deposit with a QR in one call', async () => {
    const { client, inmate } = await relative()
    await approvedCard(client, inmate.inmateId)
    const deposit = await makeDeposit(client, inmate.inmateId, 75000)

    expect(deposit.depositNo).toMatch(/^KLP-D\d{4}-\d{4}$/)
    expect(deposit.status).toBe('pending')
    expect(deposit.amountSatang).toBe(75000)
    expect(deposit.payment.purpose).toBe('deposit')
    expect(deposit.payment.depositNo).toBe(deposit.depositNo)
    // Salted, exactly like an order — the charge is what must be transferred.
    expect(deposit.payment.chargeSatang).toBeGreaterThanOrEqual(75000)
    expect(deposit.payment.qrImage).toMatch(/^data:image\/png/)
    // The zone is snapshotted, not joined live (§4.1).
    expect(deposit.zoneName).toBe(inmate.zoneName)
  })

  it('refuses to deposit without an approved card when the facility requires one', async () => {
    // This relative's card request is still waiting on staff (seed fixture).
    const { client, inmate } = await relative('0823456789')
    const cards = ((await client.json(`${BASE}/deposit-cards`)) as any).items
    expect(cards.find((c: any) => c.inmateId === inmate.inmateId).status).toBe('pending')

    const res = await client.request(`${BASE}/deposits`, {
      method: 'POST',
      json: { inmateId: inmate.inmateId, amountSatang: 50000 }
    })
    expect(res.status).toBe(403)
    expect(((await res.json()) as any).error.message).toContain('บัตรฝากเงิน')
  })

  it('enforces the facility’s minimum and maximum', async () => {
    const { client, inmate } = await relative()
    await approvedCard(client, inmate.inmateId)

    const tooSmall = await client.request(`${BASE}/deposits`, {
      method: 'POST',
      json: { inmateId: inmate.inmateId, amountSatang: 100 }
    })
    expect(tooSmall.status).toBe(400)

    const tooBig = await client.request(`${BASE}/deposits`, {
      method: 'POST',
      json: { inmateId: inmate.inmateId, amountSatang: 500_000_00 }
    })
    expect(tooBig.status).toBe(400)
  })

  it('walks pending → reviewing → completed', async () => {
    const { client, inmate } = await relative()
    await approvedCard(client, inmate.inmateId)
    const deposit = await depositAndSettle(client, inmate.inmateId, 60000)

    const admin = await staffClient()
    const afterSlip = (await admin.json(`${BASE}/admin/deposits/${deposit.id}`)) as any
    // The money is at the facility, but not yet in the inmate's account.
    expect(afterSlip.status).toBe('reviewing')
    expect(afterSlip.depositedAt).not.toBeNull()
    expect(afterSlip.completedAt).toBeNull()

    const done = (await admin.json(`${BASE}/admin/deposits/${deposit.id}/review`, {
      method: 'POST',
      json: { status: 'completed' }
    })) as any
    expect(done.status).toBe('completed')
    expect(done.completedAt).not.toBeNull()
    expect(done.reviewedByName).toBeTruthy()
  })

  it('refuses to complete a deposit whose slip has not been verified', async () => {
    const { client, inmate } = await relative()
    await approvedCard(client, inmate.inmateId)
    const deposit = await makeDeposit(client, inmate.inmateId, 55000)

    const admin = await staffClient()
    const res = await admin.request(`${BASE}/admin/deposits/${deposit.id}/review`, {
      method: 'POST',
      json: { status: 'completed' }
    })
    expect(res.status).toBe(409)
  })

  it('returns the deposit to pending when the slip is rejected', async () => {
    const { client, inmate } = await relative()
    await approvedCard(client, inmate.inmateId)
    const deposit = await makeDeposit(client, inmate.inmateId, 65000)
    const res = await uploadSlip(client, deposit.payment.id, await slipImage(nextRef()))
    expect(res.status).toBe(201)

    const admin = await staffClient('klp.finance')
    await admin.json(`${BASE}/admin/payments/${deposit.payment.id}/reject`, {
      method: 'POST',
      json: { reason: 'ยอดโอนไม่ตรง' }
    })

    const after = (await client.json(`${BASE}/deposits/${deposit.id}`)) as any
    expect(after.status).toBe('pending')
    expect(after.rejectReason).toBe('ยอดโอนไม่ตรง')
    expect(after.depositedAt).toBeNull()
  })

  it('closes the deposit as rejected when the payment is refunded', async () => {
    const { client, inmate } = await relative()
    await approvedCard(client, inmate.inmateId)
    const deposit = await depositAndSettle(client, inmate.inmateId, 70000)

    const admin = await staffClient('klp.finance')
    await admin.json(`${BASE}/admin/payments/${deposit.payment.id}/refund`, {
      method: 'POST',
      json: { reason: 'ญาติขอยกเลิก' }
    })
    const after = (await client.json(`${BASE}/deposits/${deposit.id}`)) as any
    expect(after.status).toBe('rejected')
  })

  it('issues a fresh QR for the same deposit rather than a second deposit', async () => {
    const { client, inmate } = await relative()
    await approvedCard(client, inmate.inmateId)
    const deposit = await makeDeposit(client, inmate.inmateId, 42000)

    const again = (await client.json(`${BASE}/deposits/${deposit.id}/payment`, {
      method: 'POST',
      json: {}
    })) as any
    expect(again.depositNo).toBe(deposit.depositNo)
    // The live QR is returned as-is; a refresh has not started a new payment.
    expect(again.payment.id).toBe(deposit.payment.id)
    expect(again.payment.chargeSatang).toBe(deposit.payment.chargeSatang)

    await client.json(`${BASE}/deposits/${deposit.id}/cancel`, { method: 'POST' })
    const res = await client.request(`${BASE}/deposits/${deposit.id}/payment`, {
      method: 'POST',
      json: {}
    })
    expect(res.status).toBe(409)
  })

  it('lets a relative cancel only while unpaid, and kills the QR', async () => {
    const { client, inmate } = await relative()
    await approvedCard(client, inmate.inmateId)
    const deposit = await makeDeposit(client, inmate.inmateId, 45000)

    const cancelled = (await client.json(`${BASE}/deposits/${deposit.id}/cancel`, {
      method: 'POST'
    })) as any
    expect(cancelled.status).toBe('cancelled')

    const payment = (await client.json(`${BASE}/payments/${deposit.payment.id}`)) as any
    expect(payment.status).toBe('expired')

    const again = await client.request(`${BASE}/deposits/${deposit.id}/cancel`, { method: 'POST' })
    expect(again.status).toBe(409)
  })

  it('refuses to cancel while a slip is waiting on staff', async () => {
    const { client, inmate } = await relative()
    await approvedCard(client, inmate.inmateId)
    const deposit = await makeDeposit(client, inmate.inmateId, 44000)
    await uploadSlip(client, deposit.payment.id, await slipImage(nextRef()))

    const res = await client.request(`${BASE}/deposits/${deposit.id}/cancel`, { method: 'POST' })
    expect(res.status).toBe(409)
  })

  it('caps how many deposits may be open at once for one inmate', async () => {
    const { client, inmate } = await relative()
    await approvedCard(client, inmate.inmateId)
    setSetting('deposit.max_open_per_inmate', 1, { prisonId: inmate.prisonId, db: db() })
    try {
      // The existing open deposits from earlier tests already fill the slot.
      const res = await client.request(`${BASE}/deposits`, {
        method: 'POST',
        json: { inmateId: inmate.inmateId, amountSatang: 43000 }
      })
      expect(res.status).toBe(409)
    } finally {
      setSetting('deposit.max_open_per_inmate', 20, { prisonId: inmate.prisonId, db: db() })
    }
  })

  it('shows a relative only their own deposits', async () => {
    const mine = await relative()
    const other = await relative('0823456789')
    const list = (await mine.client.json(`${BASE}/deposits?limit=100`)) as any
    expect(list.items.length).toBeGreaterThan(0)
    expect(list.items.every((d: any) => d.customerId === mine.me.id)).toBe(true)

    const first = list.items[0]
    const res = await other.client.request(`${BASE}/deposits/${first.id}`)
    expect(res.status).toBe(403)
  })

  it('scopes the review queue and refuses another facility’s deposit', async () => {
    const klp = await staffClient()
    const bkw = await staffClient('bkw.admin')
    const queue = (await klp.json(`${BASE}/admin/deposits?limit=100`)) as any
    expect(queue.items.length).toBeGreaterThan(0)
    expect(queue.items.every((d: any) => d.prisonName.includes('คลองเปรม'))).toBe(true)

    const res = await bkw.request(`${BASE}/admin/deposits/${queue.items[0].id}`)
    expect(res.status).toBe(403)
  })

  it('refuses zone_staff reviewing a deposit', async () => {
    const { client, inmate } = await relative()
    await approvedCard(client, inmate.inmateId)
    const deposit = await depositAndSettle(client, inmate.inmateId, 41000)

    const zone = await staffClient('klp.zone')
    const res = await zone.request(`${BASE}/admin/deposits/${deposit.id}/review`, {
      method: 'POST',
      json: { status: 'completed' }
    })
    expect(res.status).toBe(403)
  })

  it('finds a deposit by number and by inmate name', async () => {
    const admin = await staffClient()
    const all = (await admin.json(`${BASE}/admin/deposits?limit=1`)) as any
    const one = all.items[0]
    const byNo = (await admin.json(`${BASE}/admin/deposits?q=${one.depositNo}`)) as any
    expect(byNo.items).toHaveLength(1)
    const byName = (await admin.json(
      `${BASE}/admin/deposits?q=${encodeURIComponent(one.inmateName.split(' ')[0])}`
    )) as any
    expect(byName.items.length).toBeGreaterThan(0)
  })

  it('reports real pending and completed totals for the dashboard tile', async () => {
    const admin = await staffClient()
    const totals = (await admin.json(`${BASE}/admin/deposits/summary`)) as any
    const list = (await admin.json(`${BASE}/admin/deposits?limit=100`)) as any

    const sum = (status: string) =>
      list.items
        .filter((d: any) => d.status === status)
        .reduce((n: number, d: any) => n + d.amountSatang, 0)

    expect(totals.completedSatang).toBe(sum('completed'))
    // "Received" is money whose slip passed, credited or not.
    expect(totals.receivedSatang).toBe(sum('reviewing') + sum('completed'))
    expect(totals.pendingCount).toBe(
      list.items.filter((d: any) => d.status === 'pending').length
    )
    expect(totals.buckets.reduce((n: number, b: any) => n + b.count, 0)).toBe(list.items.length)
  })

  it('keeps the deposit out of the order flow entirely', async () => {
    const admin = await staffClient()
    const payments = (await admin.json(`${BASE}/admin/payments?purpose=deposit&limit=50`)) as any
    expect(payments.items.length).toBeGreaterThan(0)
    for (const p of payments.items) {
      expect(p.orderNo).toBeNull()
      expect(p.depositNo).toMatch(/-D\d{4}-/)
    }
  })
})
