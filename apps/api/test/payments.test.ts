import { beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { BASE, loginCustomer, loginStaff, setupApp, type TestClient } from './helpers.js'

const ctx = setupApp()
const app = () => ctx.app

const { buildSlipMiniQr, parseSlipMiniQr, buildCreditTransfer, buildBillPayment } =
  await import('../src/lib/payments/promptpay.js')
const { crcHex, parseTlv, verifyCrc } = await import('../src/lib/payments/emvco.js')
const { qrPngBuffer } = await import('../src/lib/payments/slip.js')
const { setStorage } = await import('../src/lib/storage/index.js')
const { db } = await import('../src/db/client.js')
const { payments } = await import('../src/db/schema/index.js')
const { eq } = await import('drizzle-orm')
const { enqueue } = await import('../src/lib/jobs/queue.js')
const { drainJobs } = await import('../src/lib/jobs/scheduler.js')

/** Slips never touch the disk in a test run. */
beforeAll(() => {
  const files = new Map<string, Buffer>()
  let n = 0
  setStorage({
    kind: 'local',
    async put(body, opts) {
      const key = `${opts?.prefix ?? 'misc'}/test-${++n}.jpg`
      files.set(key, Buffer.from(body))
      return {
        key,
        size: body.byteLength,
        contentType: opts?.contentType ?? null,
        url: `/f/${key}`
      }
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
})

/* ── fixtures ──────────────────────────────────────────────────────────── */

async function relative() {
  const { client } = await loginCustomer(app())
  const me = (await client.json(`${BASE}/me`)) as any
  const inmate = me.inmates.find((i: any) => i.verifyStatus === 'verified')
  return { client, inmate }
}

/** A real order, placed through the real endpoint, ready to be paid for. */
async function placeOrder(client: TestClient, inmate: any, qty = 1) {
  const shops = (await client.json(`${BASE}/shops?prisonId=${inmate.prisonId}`)) as any
  const shop = shops.items[0]
  const products = (await client.json(`${BASE}/products?shopId=${shop.id}&limit=100`)) as any
  return (await client.json(`${BASE}/orders`, {
    method: 'POST',
    json: {
      inmateId: inmate.inmateId,
      shopId: shop.id,
      items: [{ productId: products.items[0].id, qty }]
    }
  })) as any
}

/**
 * A plausible bank slip: a tall white page with a real mini-QR printed near
 * the bottom, which is where the decoder is told to look.
 */
async function slipImage(transRef: string, sendingBank = '004'): Promise<Buffer> {
  const qr = await qrPngBuffer(buildSlipMiniQr(sendingBank, transRef), 220)
  return sharp({
    create: { width: 760, height: 1200, channels: 3, background: '#ffffff' }
  })
    .composite([{ input: qr, top: 900, left: 470 }])
    .jpeg({ quality: 92 })
    .toBuffer()
}

async function uploadSlip(client: TestClient, paymentId: string, image: Buffer) {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(image)], { type: 'image/jpeg' }), 'slip.jpg')
  return client.request(`${BASE}/payments/${paymentId}/slip`, { method: 'POST', body: form })
}

const channelsFor = async (client: TestClient, prisonId: string) =>
  ((await client.json(`${BASE}/payment-channels?prisonId=${prisonId}`)) as any).items as any[]

/* ── EMVCo ─────────────────────────────────────────────────────────────── */

describe('EMVCo payload construction', () => {
  it('computes CRC-16/CCITT-FALSE', () => {
    // The canonical check value for the algorithm.
    expect(crcHex('123456789')).toBe('29B1')
  })

  it('builds a tag-29 credit transfer carrying the proxy and the exact amount', () => {
    const payload = buildCreditTransfer({
      proxyType: 'mobile',
      proxyValue: '0812223333',
      chargeSatang: 47037
    })
    expect(verifyCrc(payload)).toBe(true)
    const tags = parseTlv(payload)!
    expect(tags.find((t) => t.id === '53')?.value).toBe('764')
    expect(tags.find((t) => t.id === '58')?.value).toBe('TH')
    // Two decimals, always — a relative who transfers ฿470.40 has not paid.
    expect(tags.find((t) => t.id === '54')?.value).toBe('470.37')
    // Mobile proxies travel as 0066 + the number without its leading zero.
    expect(payload).toContain('0066812223333')
    expect(payload).toContain('A000000677010111')
  })

  it('builds a tag-30 bill payment carrying the biller id and Ref1', () => {
    const payload = buildBillPayment({
      billerId: '099400012345601',
      ref1: 'KLP-P2508-0001',
      ref2: 'KLP001',
      chargeSatang: 25000
    })
    expect(verifyCrc(payload)).toBe(true)
    expect(payload).toContain('A000000677010112')
    expect(payload).toContain('099400012345601')
    // Ref fields are uppercase alphanumeric; the dashes are stripped.
    expect(payload).toContain('KLPP25080001')
  })

  it('reads a slip mini-QR and refuses to invent one from noise', () => {
    const parsed = parseSlipMiniQr(buildSlipMiniQr('004', '01523471X8899'))
    expect(parsed.transRef).toBe('01523471X8899')
    expect(parsed.sendingBank).toBe('004')
    expect(parsed.crcOk).toBe(true)

    const junk = parseSlipMiniQr('not a tlv payload at all')
    expect(junk.transRef).toBeNull()
    expect(junk.crcOk).toBe(false)
  })
})

/* ── channels ──────────────────────────────────────────────────────────── */

describe('payment channels', () => {
  it('offers the facility rails plus department-wide ones, and leaks neither biller id nor proxy', async () => {
    const { client, inmate } = await relative()
    const items = await channelsFor(client, inmate.prisonId)

    expect(items.length).toBeGreaterThan(0)
    expect(items.every((c) => 'billerId' in c === false)).toBe(true)
    expect(items.every((c) => 'targetValue' in c === false)).toBe(true)
    // The seeded department-wide tag-30 channel is inactive until a real
    // Biller ID exists, so it must not appear.
    expect(items.some((c) => c.rail === 'promptpay_bill_payment')).toBe(false)
    expect(items[0].priority).toBeUndefined()
  })

  it('refuses a tag-30 channel without a biller id and a tag-29 channel without a proxy', async () => {
    const { client } = await loginStaff(app())
    const prisons = (await client.json(`${BASE}/prisons`)) as any
    const prisonId = prisons.items[0].id

    const noBiller = await client.request(`${BASE}/admin/payment-channels`, {
      method: 'POST',
      json: {
        prisonId,
        rail: 'promptpay_bill_payment',
        displayName: 'ไม่มี biller',
        supportsPurposes: ['order']
      }
    })
    expect(noBiller.status).toBe(422)

    const noProxy = await client.request(`${BASE}/admin/payment-channels`, {
      method: 'POST',
      json: {
        prisonId,
        rail: 'promptpay_credit_transfer',
        displayName: 'ไม่มีพร้อมเพย์',
        supportsPurposes: ['order']
      }
    })
    expect(noProxy.status).toBe(422)
  })

  it('pins a prison admin channel to their own facility', async () => {
    const { client } = await loginStaff(app(), 'klp.admin')
    const created = await client.request(`${BASE}/admin/payment-channels`, {
      method: 'POST',
      json: {
        // Asking for a department-wide channel; the scope decides otherwise.
        prisonId: null,
        rail: 'bank_transfer',
        displayName: 'บัญชีสำรอง (ทดสอบขอบเขต)',
        bankCode: '004',
        accountNo: '555-5-55555-5',
        accountName: 'ทดสอบ',
        supportsPurposes: ['order']
      }
    })
    expect(created.status).toBe(201)
    const channel = (await created.json()) as any
    expect(channel.prisonId).not.toBeNull()
    expect(channel.prisonName).toContain('คลองเปรม')
  })
})

/* ── creating a payment ────────────────────────────────────────────────── */

describe('requesting a QR', () => {
  it('salts the amount, renders the QR server-side and never trusts a client total', async () => {
    const { client, inmate } = await relative()
    const order = await placeOrder(client, inmate)

    const res = await client.request(`${BASE}/orders/${order.id}/payment`, {
      method: 'POST',
      json: {}
    })
    expect(res.status).toBe(201)
    const payment = (await res.json()) as any

    expect(payment.paymentNo).toMatch(/^KLP-P\d{4}-\d{4}$/)
    expect(payment.amountSatang).toBe(order.totalSatang)
    expect(payment.amountSaltSatang).toBeGreaterThanOrEqual(1)
    expect(payment.amountSaltSatang).toBeLessThanOrEqual(99)
    expect(payment.chargeSatang).toBe(payment.amountSatang + payment.amountSaltSatang)
    expect(payment.status).toBe('pending')
    expect(payment.qrImage.startsWith('data:image/png;base64,')).toBe(true)
    expect(verifyCrc(payment.qrPayload)).toBe(true)
    expect(payment.qrPayload).toContain((payment.chargeSatang / 100).toFixed(2))
    expect(payment.expiresAt).toBeGreaterThan(Date.now())
  })

  it('returns the same QR when the pay screen is reloaded', async () => {
    const { client, inmate } = await relative()
    const order = await placeOrder(client, inmate)

    const first = (await client.json(`${BASE}/orders/${order.id}/payment`, {
      method: 'POST',
      json: {}
    })) as any
    const second = (await client.json(`${BASE}/orders/${order.id}/payment`, {
      method: 'POST',
      json: {}
    })) as any
    expect(second.paymentNo).toBe(first.paymentNo)
    expect(second.chargeSatang).toBe(first.chargeSatang)
  })

  it('gives two identical totals on one channel two different charged amounts', async () => {
    const { client, inmate } = await relative()
    const a = await placeOrder(client, inmate, 2)
    const b = await placeOrder(client, inmate, 2)
    expect(a.totalSatang).toBe(b.totalSatang)

    const pa = (await client.json(`${BASE}/orders/${a.id}/payment`, {
      method: 'POST',
      json: {}
    })) as any
    const pb = (await client.json(`${BASE}/orders/${b.id}/payment`, {
      method: 'POST',
      json: {}
    })) as any
    // Without this, the bank statement cannot tell the two apart at all.
    expect(pa.chargeSatang).not.toBe(pb.chargeSatang)
  })

  it('retires the old QR when the relative switches rails', async () => {
    const { client, inmate } = await relative()
    const order = await placeOrder(client, inmate)
    const channels = await channelsFor(client, inmate.prisonId)
    const other = channels.find((c) => c.rail === 'bank_transfer')!

    const first = (await client.json(`${BASE}/orders/${order.id}/payment`, {
      method: 'POST',
      json: {}
    })) as any
    const second = (await client.json(`${BASE}/orders/${order.id}/payment`, {
      method: 'POST',
      json: { channelId: other.id }
    })) as any

    expect(second.paymentNo).not.toBe(first.paymentNo)
    expect(second.rail).toBe('bank_transfer')
    // A bank transfer has no QR — the account number is the instruction.
    expect(second.qrPayload).toBeNull()
    expect(second.accountNo).toBeTruthy()

    const stale = (await client.json(`${BASE}/payments/${first.id}`)) as any
    expect(stale.status).toBe('expired')
  })

  it('refuses to bill someone else order, or an order already paid', async () => {
    const { client, inmate } = await relative()
    const order = await placeOrder(client, inmate)

    const stranger = await loginCustomer(app(), '0845678901')
    const res = await stranger.client.request(`${BASE}/orders/${order.id}/payment`, {
      method: 'POST',
      json: {}
    })
    expect(res.status).toBe(403)
  })
})

/* ── the slip pipeline ─────────────────────────────────────────────────── */

describe('slip upload', () => {
  it('strips the image, reads the mini-QR and parks the order for review', async () => {
    const { client, inmate } = await relative()
    const order = await placeOrder(client, inmate)
    const payment = (await client.json(`${BASE}/orders/${order.id}/payment`, {
      method: 'POST',
      json: {}
    })) as any

    const res = await uploadSlip(client, payment.id, await slipImage('SLIP0000000001'))
    expect(res.status).toBe(201)
    const body = (await res.json()) as any

    expect(body.hint.decoded).toBe(true)
    expect(body.hint.transRef).toBe('SLIP0000000001')
    expect(body.hint.sendingBank).toBe('004')
    expect(body.payment.status).toBe('awaiting_verify')
    expect(body.payment.slipUrl).toBe(`/api/v1/payments/${payment.id}/slip`)
    // A pending QR stops being rendered once a slip is in the queue.
    expect(body.payment.qrImage).toBeNull()

    const after = (await client.json(`${BASE}/orders/${order.id}`)) as any
    expect(after.paymentStatus).toBe('awaiting_verify')

    const img = await client.request(`${BASE}/payments/${payment.id}/slip`)
    expect(img.status).toBe(200)
    expect(img.headers.get('content-type')).toBe('image/jpeg')
    // Re-encoded to JPEG, which is what discards the EXIF GPS block.
    const bytes = Buffer.from(await img.arrayBuffer())
    expect(bytes.subarray(0, 2).toString('hex')).toBe('ffd8')
  })

  it('refuses a slip whose reference already settled another payment', async () => {
    const { client, inmate } = await relative()
    const first = await placeOrder(client, inmate)
    const second = await placeOrder(client, inmate)

    const p1 = (await client.json(`${BASE}/orders/${first.id}/payment`, {
      method: 'POST',
      json: {}
    })) as any
    const p2 = (await client.json(`${BASE}/orders/${second.id}/payment`, {
      method: 'POST',
      json: {}
    })) as any

    const image = await slipImage('DUPLICATE12345')
    expect((await uploadSlip(client, p1.id, image)).status).toBe(201)

    const dup = await uploadSlip(client, p2.id, image)
    expect(dup.status).toBe(409)
    expect(((await dup.json()) as any).error.message).toContain('ถูกใช้')
  })

  it('refuses a file that is not an image', async () => {
    const { client, inmate } = await relative()
    const order = await placeOrder(client, inmate)
    const payment = (await client.json(`${BASE}/orders/${order.id}/payment`, {
      method: 'POST',
      json: {}
    })) as any

    const form = new FormData()
    form.append('file', new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/jpeg' }), 'x.jpg')
    const res = await client.request(`${BASE}/payments/${payment.id}/slip`, {
      method: 'POST',
      body: form
    })
    expect(res.status).toBe(400)
  })

  it('accepts a slip with no readable mini-QR and leaves the reference to staff', async () => {
    const { client, inmate } = await relative()
    const order = await placeOrder(client, inmate)
    const payment = (await client.json(`${BASE}/orders/${order.id}/payment`, {
      method: 'POST',
      json: {}
    })) as any

    const blank = await sharp({
      create: { width: 600, height: 900, channels: 3, background: '#ffffff' }
    })
      .jpeg()
      .toBuffer()
    const res = await uploadSlip(client, payment.id, blank)
    expect(res.status).toBe(201)
    const body = (await res.json()) as any
    expect(body.hint.decoded).toBe(false)
    expect(body.payment.status).toBe('awaiting_verify')
  })
})

/* ── manual verification ───────────────────────────────────────────────── */

/** Places an order, requests a QR, uploads a slip. Returns everything. */
async function readyForReview(transRef: string) {
  const { client, inmate } = await relative()
  const order = await placeOrder(client, inmate)
  const payment = (await client.json(`${BASE}/orders/${order.id}/payment`, {
    method: 'POST',
    json: {}
  })) as any
  await uploadSlip(client, payment.id, await slipImage(transRef))
  return { client, order, payment }
}

describe('manual verification', () => {
  it('settles the order when the slip matches to the satang', async () => {
    const { client, order, payment } = await readyForReview('VERIFY00000001')
    const staff = await loginStaff(app(), 'klp.admin')

    const res = await staff.client.request(`${BASE}/admin/payments/${payment.id}/verify`, {
      method: 'POST',
      json: {
        transRef: 'VERIFY00000001',
        transferAmountSatang: payment.chargeSatang,
        transferredAt: Date.now(),
        sendingBank: '004'
      }
    })
    expect(res.status).toBe(200)
    const detail = (await res.json()) as any
    expect(detail.status).toBe('succeeded')
    expect(detail.verifyMethod).toBe('manual')
    expect(detail.verifiedByName).toBeTruthy()

    const after = (await client.json(`${BASE}/orders/${order.id}`)) as any
    expect(after.paymentStatus).toBe('paid')
    expect(after.paidAt).toBeGreaterThan(0)
  })

  it('rejects a slip that is one satang short', async () => {
    const { payment } = await readyForReview('WRONGAMOUNT001')
    const staff = await loginStaff(app(), 'klp.admin')

    const res = await staff.client.request(`${BASE}/admin/payments/${payment.id}/verify`, {
      method: 'POST',
      json: {
        transRef: 'WRONGAMOUNT001',
        // Exactly the salt short: the case amount salting exists to catch.
        transferAmountSatang: payment.amountSatang,
        transferredAt: Date.now()
      }
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.message).toContain('ยอดโอนไม่ตรง')

    const still = (await staff.client.json(`${BASE}/admin/payments/${payment.id}`)) as any
    expect(still.status).toBe('awaiting_verify')
  })

  it('rejects a transfer timestamped long after the QR lapsed', async () => {
    const { payment } = await readyForReview('TOOLATE0000001')
    const staff = await loginStaff(app(), 'klp.admin')

    const res = await staff.client.request(`${BASE}/admin/payments/${payment.id}/verify`, {
      method: 'POST',
      json: {
        transRef: 'TOOLATE0000001',
        transferAmountSatang: payment.chargeSatang,
        transferredAt: Date.now() + 30 * 24 * 60 * 60 * 1000
      }
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as any).error.message).toContain('เลยกำหนด')
  })

  it('refuses a reference that already settled somewhere else', async () => {
    const a = await readyForReview('SHAREDREF00001')
    const staff = await loginStaff(app(), 'klp.admin')
    const ok = await staff.client.request(`${BASE}/admin/payments/${a.payment.id}/verify`, {
      method: 'POST',
      json: {
        transRef: 'SHAREDREF00001',
        transferAmountSatang: a.payment.chargeSatang,
        transferredAt: Date.now()
      }
    })
    expect(ok.status).toBe(200)

    // A second payment whose own slip carried nothing, but whose reviewer
    // types in a reference that is already spent.
    const { client, inmate } = await relative()
    const order = await placeOrder(client, inmate)
    const payment = (await client.json(`${BASE}/orders/${order.id}/payment`, {
      method: 'POST',
      json: {}
    })) as any
    const blank = await sharp({
      create: { width: 600, height: 900, channels: 3, background: '#ffffff' }
    })
      .jpeg()
      .toBuffer()
    await uploadSlip(client, payment.id, blank)

    const dup = await staff.client.request(`${BASE}/admin/payments/${payment.id}/verify`, {
      method: 'POST',
      json: {
        transRef: 'SHAREDREF00001',
        transferAmountSatang: payment.chargeSatang,
        transferredAt: Date.now()
      }
    })
    expect(dup.status).toBe(409)
  })

  it('sends a rejected order back to unpaid so the relative can pay again', async () => {
    const { client, order, payment } = await readyForReview('REJECTME000001')
    const staff = await loginStaff(app(), 'klp.admin')

    const res = await staff.client.request(`${BASE}/admin/payments/${payment.id}/reject`, {
      method: 'POST',
      json: { reason: 'ภาพสลิปไม่ชัด อ่านยอดไม่ออก' }
    })
    expect(res.status).toBe(200)
    expect(((await res.json()) as any).status).toBe('failed')

    const after = (await client.json(`${BASE}/orders/${order.id}`)) as any
    expect(after.paymentStatus).toBe('unpaid')

    const retry = await client.request(`${BASE}/orders/${order.id}/payment`, {
      method: 'POST',
      json: {}
    })
    expect(retry.status).toBe(201)
  })

  it('lets finance verify but not zone staff', async () => {
    const { payment } = await readyForReview('ROLECHECK00001')

    const zone = await loginStaff(app(), 'klp.zone')
    const refused = await zone.client.request(`${BASE}/admin/payments/${payment.id}/verify`, {
      method: 'POST',
      json: {
        transRef: 'ROLECHECK00001',
        transferAmountSatang: payment.chargeSatang,
        transferredAt: Date.now()
      }
    })
    expect(refused.status).toBe(403)

    const finance = await loginStaff(app(), 'klp.finance')
    const allowed = await finance.client.request(`${BASE}/admin/payments/${payment.id}/verify`, {
      method: 'POST',
      json: {
        transRef: 'ROLECHECK00001',
        transferAmountSatang: payment.chargeSatang,
        transferredAt: Date.now()
      }
    })
    expect(allowed.status).toBe(200)
  })

  it('refuses a cross-facility read of a payment', async () => {
    const { payment } = await readyForReview('SCOPECHECK0001')
    const other = await loginStaff(app(), 'bkw.admin')
    const res = await other.client.request(`${BASE}/admin/payments/${payment.id}`)
    expect(res.status).toBe(403)
  })
})

/* ── the tag-30 rail ───────────────────────────────────────────────────── */

describe('bill payment rail', () => {
  it('settles an order through tag-30 with Ref1 carrying the payment number', async () => {
    const admin = await loginStaff(app())
    const { client, inmate } = await relative()

    const created = (await admin.client.json(`${BASE}/admin/payment-channels`, {
      method: 'POST',
      json: {
        prisonId: inmate.prisonId,
        rail: 'promptpay_bill_payment',
        displayName: 'ชำระบิลทดสอบ',
        priority: 1,
        billerId: '0994000123456',
        terminalSuffix: '02',
        ref1Mode: 'payment_no',
        ref2Mode: 'inmate_code',
        bankCode: '006',
        supportsPurposes: ['order']
      }
    })) as any
    expect(created.billerId).toBe('099400012345602')

    const order = await placeOrder(client, inmate)
    const payment = (await client.json(`${BASE}/orders/${order.id}/payment`, {
      method: 'POST',
      json: { channelId: created.id }
    })) as any

    expect(payment.rail).toBe('promptpay_bill_payment')
    // tag-30 has Ref1; salting it would be noise on an already-exact rail.
    expect(payment.amountSaltSatang).toBe(0)
    expect(payment.chargeSatang).toBe(order.totalSatang)
    expect(payment.qrRef1).toBe(payment.paymentNo.replace(/-/g, ''))
    expect(payment.qrRef2).toBe(order.inmateCode.replace(/[^0-9A-Z]/gi, '').toUpperCase())
    expect(payment.qrPayload).toContain('099400012345602')
    expect(verifyCrc(payment.qrPayload)).toBe(true)

    await uploadSlip(client, payment.id, await slipImage('BILLPAY0000001'))
    const res = await admin.client.request(`${BASE}/admin/payments/${payment.id}/verify`, {
      method: 'POST',
      json: {
        transRef: 'BILLPAY0000001',
        transferAmountSatang: payment.chargeSatang,
        transferredAt: Date.now()
      }
    })
    expect(res.status).toBe(200)
    const paid = (await client.json(`${BASE}/orders/${order.id}`)) as any
    expect(paid.paymentStatus).toBe('paid')
  })
})

/* ── expiry, refund, cancellation ──────────────────────────────────────── */

describe('expiry and refunds', () => {
  it('expires a QR nobody paid, and refuses a slip against it', async () => {
    const { client, inmate } = await relative()
    const order = await placeOrder(client, inmate)
    const payment = (await client.json(`${BASE}/orders/${order.id}/payment`, {
      method: 'POST',
      json: {}
    })) as any

    // Reach into the row rather than waiting 30 minutes.
    db()
      .update(payments)
      .set({ expiresAt: Date.now() - 60_000 })
      .where(eq(payments.id, payment.id))
      .run()

    enqueue('payment.expire')
    await drainJobs()

    const after = (await client.json(`${BASE}/payments/${payment.id}`)) as any
    expect(after.status).toBe('expired')

    const late = await uploadSlip(client, payment.id, await slipImage('TOOLATESLIP001'))
    expect(late.status).toBe(409)

    // ...and asking again issues a fresh one rather than reviving the dead QR.
    const fresh = (await client.json(`${BASE}/orders/${order.id}/payment`, {
      method: 'POST',
      json: {}
    })) as any
    expect(fresh.id).not.toBe(payment.id)
    expect(fresh.status).toBe('pending')
  })

  it('leaves a slip awaiting review alone when the expiry job runs', async () => {
    const { payment } = await readyForReview('DONTEXPIRE0001')
    db()
      .update(payments)
      .set({ expiresAt: Date.now() - 60_000 })
      .where(eq(payments.id, payment.id))
      .run()

    enqueue('payment.expire')
    await drainJobs()

    const staff = await loginStaff(app(), 'klp.admin')
    const after = (await staff.client.json(`${BASE}/admin/payments/${payment.id}`)) as any
    expect(after.status).toBe('awaiting_verify')
  })

  it('blocks cancelling an order with money on it until the payment is settled or refunded', async () => {
    const { order, payment } = await readyForReview('REFUNDME000001')
    const staff = await loginStaff(app(), 'klp.admin')

    const blocked = await staff.client.request(`${BASE}/admin/orders/${order.id}/fulfillment`, {
      method: 'PATCH',
      json: { status: 'cancelled', reason: 'ผู้ต้องขังย้ายเรือนจำ' }
    })
    expect(blocked.status).toBe(409)

    await staff.client.request(`${BASE}/admin/payments/${payment.id}/verify`, {
      method: 'POST',
      json: {
        transRef: 'REFUNDME000001',
        transferAmountSatang: payment.chargeSatang,
        transferredAt: Date.now()
      }
    })
    const stillBlocked = await staff.client.request(
      `${BASE}/admin/orders/${order.id}/fulfillment`,
      { method: 'PATCH', json: { status: 'cancelled', reason: 'ผู้ต้องขังย้ายเรือนจำ' } }
    )
    expect(stillBlocked.status).toBe(409)

    const refunded = await staff.client.request(`${BASE}/admin/payments/${payment.id}/refund`, {
      method: 'POST',
      json: { reason: 'ยกเลิกคำสั่งซื้อ' }
    })
    expect(refunded.status).toBe(200)
    expect(((await refunded.json()) as any).status).toBe('refunded')

    const cancelled = await staff.client.request(`${BASE}/admin/orders/${order.id}/fulfillment`, {
      method: 'PATCH',
      json: { status: 'cancelled', reason: 'ผู้ต้องขังย้ายเรือนจำ' }
    })
    expect(cancelled.status).toBe(200)
  })

  it('kills a live QR when the order behind it is cancelled', async () => {
    const { client, inmate } = await relative()
    const order = await placeOrder(client, inmate)
    const payment = (await client.json(`${BASE}/orders/${order.id}/payment`, {
      method: 'POST',
      json: {}
    })) as any

    const staff = await loginStaff(app(), 'klp.admin')
    const res = await staff.client.request(`${BASE}/admin/orders/${order.id}/fulfillment`, {
      method: 'PATCH',
      json: { status: 'cancelled', reason: 'สินค้าหมด' }
    })
    expect(res.status).toBe(200)

    const after = (await client.json(`${BASE}/payments/${payment.id}`)) as any
    expect(after.status).toBe('expired')
  })
})

/* ── the p.9 list ──────────────────────────────────────────────────────── */

describe('payment list', () => {
  it('scopes to the caller facility and filters by status', async () => {
    await readyForReview('LISTCHECK00001')
    const klp = await loginStaff(app(), 'klp.admin')
    const bkw = await loginStaff(app(), 'bkw.admin')

    const mine = (await klp.client.json(`${BASE}/admin/payments?limit=100`)) as any
    expect(mine.items.length).toBeGreaterThan(0)
    expect(mine.items.every((p: any) => p.prisonName.includes('คลองเปรม'))).toBe(true)
    expect(mine.items[0].customerName).toBeTruthy()

    const theirs = (await bkw.client.json(`${BASE}/admin/payments?limit=100`)) as any
    expect(theirs.items.length).toBe(0)

    const queue = (await klp.client.json(
      `${BASE}/admin/payments?status=awaiting_verify&limit=100`
    )) as any
    expect(queue.items.every((p: any) => p.status === 'awaiting_verify')).toBe(true)
    expect(queue.items.every((p: any) => p.orderNo)).toBe(true)
  })

  it('lets a relative read their own payments and nobody else', async () => {
    const { client } = await relative()
    const mine = (await client.json(`${BASE}/payments?limit=100`)) as any
    expect(mine.items.length).toBeGreaterThan(0)

    const stranger = await loginCustomer(app(), '0845678901')
    const res = await stranger.client.request(`${BASE}/payments/${mine.items[0].id}`)
    expect(res.status).toBe(403)
  })
})
