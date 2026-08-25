import { beforeAll, describe, expect, it } from 'vitest'
import sharp from 'sharp'
import { BASE, loginCustomer, loginStaff, setupApp, type TestClient } from './helpers.js'

const ctx = setupApp()
const app = () => ctx.app

const { qrPngBuffer } = await import('../src/lib/payments/slip.js')
const { replyQrPayload } = await import('../src/lib/letters/template.js')
const { setLetterRenderer, htmlRenderer } = await import('../src/lib/letters/render.js')
const { setStorage } = await import('../src/lib/storage/index.js')
const { drainJobs } = await import('../src/lib/jobs/scheduler.js')
const { onLetterPurchasePaymentVerified } = await import('../src/modules/letters/status.js')
const { db } = await import('../src/db/client.js')
const { staff } = await import('../src/db/schema/index.js')

const superAdminId = () =>
  db()
    .select()
    .from(staff)
    .all()
    .find((s) => s.username === 'superadmin')!.id

const files = new Map<string, Buffer>()

beforeAll(() => {
  let n = 0
  setStorage({
    kind: 'local',
    async put(body, opts) {
      const key = `${opts?.prefix ?? 'misc'}/test-${++n}`
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
  // No Chromium in CI. The HTML renderer produces the identical document; the
  // seam is the thing under test, not the browser.
  setLetterRenderer(htmlRenderer)
})

/* ── fixtures ──────────────────────────────────────────────────────────── */

async function relative(username = '0812345678') {
  const { client } = await loginCustomer(app(), username)
  const me = (await client.json(`${BASE}/me`)) as any
  const inmate = me.inmates.find((i: any) => i.verifyStatus === 'verified')
  return { client, inmate, me }
}

const staffClient = async (username = 'klp.letters') => (await loginStaff(app(), username)).client

/** Grants coupons the way a verified slip does, without producing a slip. */
async function grant(client: TestClient, direction: 'to_prison' | 'to_home', times = 1) {
  const { items } = (await client.json(`${BASE}/letter-packages?direction=${direction}`)) as any
  for (let i = 0; i < times; i++) {
    const purchase = (await client.json(`${BASE}/letter-packages/${items[0].id}/purchase`, {
      method: 'POST',
      json: {}
    })) as any
    onLetterPurchasePaymentVerified(purchase.id, Date.now(), superAdminId(), db())
  }
}

async function photo(): Promise<Blob> {
  const buf = await sharp({
    create: { width: 900, height: 700, channels: 3, background: '#c8e6c9' }
  })
    .jpeg()
    .toBuffer()
  return new Blob([new Uint8Array(buf)], { type: 'image/jpeg' })
}

/** A scanned reply sheet: white A4-ish page with the reply QR near the top right. */
async function scanSheet(letterNo: string): Promise<Blob> {
  const qr = await qrPngBuffer(replyQrPayload(letterNo), 300)
  const page = await sharp({
    create: { width: 1240, height: 1754, channels: 3, background: '#ffffff' }
  })
    .composite([{ input: qr, top: 60, left: 860 }])
    .jpeg({ quality: 92 })
    .toBuffer()
  return new Blob([new Uint8Array(page)], { type: 'image/jpeg' })
}

async function upload(
  client: TestClient,
  path: string,
  blob: Blob,
  filename: string,
  extra: Record<string, string> = {}
) {
  const form = new FormData()
  form.append('file', blob, filename)
  for (const [k, v] of Object.entries(extra)) form.append(k, v)
  return client.request(`${BASE}${path}`, { method: 'POST', body: form })
}

async function draftAndSubmit(client: TestClient, inmateId: string, body = 'สวัสดีครับพ่อ') {
  const letter = (await client.json(`${BASE}/letters`, {
    method: 'POST',
    json: { inmateId, bodyText: body }
  })) as any
  return (await client.json(`${BASE}/letters/${letter.id}/submit`, { method: 'POST' })) as any
}

/* ── packages + credits ────────────────────────────────────────────────── */

describe('แพ็กเกจและสิทธิ์จดหมาย', () => {
  it('เสนอแพ็กเกจส่วนกลางทั้งสองทิศทาง', async () => {
    const { client } = await relative()
    const body = (await client.json(`${BASE}/letter-packages`)) as any
    expect(body.items.length).toBeGreaterThanOrEqual(2)
    expect(new Set(body.items.map((p: any) => p.direction))).toEqual(
      new Set(['to_prison', 'to_home'])
    )
  })

  it('การซื้อสร้าง QR แต่ยังไม่ให้สิทธิ์จนกว่าสลิปจะผ่าน', async () => {
    const { client } = await relative()
    const packages = (await client.json(`${BASE}/letter-packages?direction=to_home`)) as any
    const before = (await client.json(`${BASE}/letters/credits`)) as any

    const res = await client.request(`${BASE}/letter-packages/${packages.items[0].id}/purchase`, {
      method: 'POST',
      json: {}
    })
    expect(res.status).toBe(201)
    const purchase = (await res.json()) as any
    expect(purchase.purchaseNo).toMatch(/^KLP-M\d{4}-\d{4}$/)
    expect(purchase.payment.qrPayload).toBeTruthy()
    expect(purchase.payment.letterPurchaseNo).toBe(purchase.purchaseNo)
    expect(purchase.status).toBe('pending')

    const after = (await client.json(`${BASE}/letters/credits`)) as any
    expect(after.balance.toHome).toBe(before.balance.toHome)
  })

  it('สลิปที่ผ่านแล้วเติมสิทธิ์ตามโควตา และบันทึกลง ledger', async () => {
    const { client } = await relative()
    const before = (await client.json(`${BASE}/letters/credits`)) as any
    await grant(client, 'to_prison')
    const after = (await client.json(`${BASE}/letters/credits`)) as any

    expect(after.balance.toPrison).toBe(before.balance.toPrison + 10)
    expect(after.ledger[0].reason).toBe('purchase')
    expect(after.ledger[0].delta).toBe(10)
    expect(after.ledger[0].balanceAfter).toBe(after.balance.toPrison)
  })

  it('ยืนยันสลิปซ้ำไม่เติมสิทธิ์ซ้ำ', async () => {
    const { client } = await relative()
    const packages = (await client.json(`${BASE}/letter-packages?direction=to_prison`)) as any
    const purchase = (await client.json(
      `${BASE}/letter-packages/${packages.items[0].id}/purchase`,
      { method: 'POST', json: {} }
    )) as any

    onLetterPurchasePaymentVerified(purchase.id, Date.now(), superAdminId(), db())
    const once = (await client.json(`${BASE}/letters/credits`)) as any
    onLetterPurchasePaymentVerified(purchase.id, Date.now(), superAdminId(), db())
    const twice = (await client.json(`${BASE}/letters/credits`)) as any

    expect(twice.balance.toPrison).toBe(once.balance.toPrison)
  })

  it('ญาติที่ยังไม่ได้รับการยืนยันซื้อแพ็กเกจไม่ได้', async () => {
    const { client } = await relative('0845678901')
    const packages = (await client.json(`${BASE}/letter-packages`)) as any
    const res = await client.request(`${BASE}/letter-packages/${packages.items[0].id}/purchase`, {
      method: 'POST',
      json: {}
    })
    expect(res.status).toBe(403)
  })
})

/* ── compose ───────────────────────────────────────────────────────────── */

describe('การเขียนและส่งจดหมาย', () => {
  it('ฉบับร่างไม่ตัดสิทธิ์ แต่การส่งเข้าคิวตัด', async () => {
    const { client, inmate } = await relative()
    await grant(client, 'to_prison')
    const before = (await client.json(`${BASE}/letters/credits`)) as any

    const draft = (await client.json(`${BASE}/letters`, {
      method: 'POST',
      json: { inmateId: inmate.inmateId, bodyText: 'ถึงพ่อ สบายดีไหมคะ' }
    })) as any
    expect(draft.status).toBe('draft')
    expect(draft.letterNo).toMatch(/^KLP-L\d{4}-\d{4}$/)
    expect(((await client.json(`${BASE}/letters/credits`)) as any).balance.toPrison).toBe(
      before.balance.toPrison
    )

    const queued = (await client.json(`${BASE}/letters/${draft.id}/submit`, {
      method: 'POST'
    })) as any
    expect(queued.status).toBe('queued')
    const after = (await client.json(`${BASE}/letters/credits`)) as any
    expect(after.balance.toPrison).toBe(before.balance.toPrison - 1)
    expect(after.ledger[0].reason).toBe('consume')
  })

  it('ไม่มีสิทธิ์คงเหลือ ส่งเข้าคิวไม่ได้', async () => {
    const { client, inmate } = await relative('0823456789')
    const draft = (await client.json(`${BASE}/letters`, {
      method: 'POST',
      json: { inmateId: inmate.inmateId, bodyText: 'ทดสอบ' }
    })) as any
    const res = await client.request(`${BASE}/letters/${draft.id}/submit`, { method: 'POST' })
    expect(res.status).toBe(409)
  })

  it('จดหมายว่างเปล่าส่งไม่ได้', async () => {
    const { client, inmate } = await relative()
    await grant(client, 'to_prison')
    const draft = (await client.json(`${BASE}/letters`, {
      method: 'POST',
      json: { inmateId: inmate.inmateId, bodyText: '' }
    })) as any
    const res = await client.request(`${BASE}/letters/${draft.id}/submit`, { method: 'POST' })
    expect(res.status).toBe(400)
  })

  it('แนบรูปได้เฉพาะฉบับร่าง และเกินโควตาไม่ได้', async () => {
    const { client, inmate } = await relative()
    await grant(client, 'to_prison')
    const draft = (await client.json(`${BASE}/letters`, {
      method: 'POST',
      json: { inmateId: inmate.inmateId, bodyText: 'มีรูปมาฝากค่ะ' }
    })) as any

    for (let i = 0; i < 3; i++) {
      const res = await upload(client, `/letters/${draft.id}/attachments`, await photo(), 'p.jpg')
      expect(res.status).toBe(201)
    }
    const tooMany = await upload(client, `/letters/${draft.id}/attachments`, await photo(), 'p.jpg')
    expect(tooMany.status).toBe(409)

    const detail = (await client.json(`${BASE}/letters/${draft.id}`)) as any
    expect(detail.attachmentCount).toBe(3)
    expect(detail.attachments).toHaveLength(3)

    const image = await client.request(`${BASE}${detail.attachments[0].url.replace('/api/v1', '')}`)
    expect(image.status).toBe(200)
    expect(image.headers.get('content-type')).toBe('image/jpeg')

    await client.json(`${BASE}/letters/${draft.id}/submit`, { method: 'POST' })
    const afterSubmit = await upload(
      client,
      `/letters/${draft.id}/attachments`,
      await photo(),
      'p.jpg'
    )
    expect(afterSubmit.status).toBe(409)
  })

  it('ยกเลิกจดหมายที่เข้าคิวแล้วคืนสิทธิ์ให้หนึ่งฉบับ', async () => {
    const { client, inmate } = await relative()
    await grant(client, 'to_prison')
    const queued = await draftAndSubmit(client, inmate.inmateId)
    const spent = (await client.json(`${BASE}/letters/credits`)) as any

    const cancelled = (await client.json(`${BASE}/letters/${queued.id}/cancel`, {
      method: 'POST'
    })) as any
    expect(cancelled.status).toBe('rejected')

    const refunded = (await client.json(`${BASE}/letters/credits`)) as any
    expect(refunded.balance.toPrison).toBe(spent.balance.toPrison + 1)
    expect(refunded.ledger[0].reason).toBe('refund')
  })

  it('ญาติเห็นเฉพาะจดหมายของตัวเอง', async () => {
    const a = await relative()
    await grant(a.client, 'to_prison')
    const mine = await draftAndSubmit(a.client, a.inmate.inmateId)

    const b = await relative('0823456789')
    const res = await b.client.request(`${BASE}/letters/${mine.id}`)
    expect(res.status).toBe(403)
  })
})

/* ── print queue + batch ───────────────────────────────────────────────── */

describe('คิวพิมพ์และรอบพิมพ์ A4', () => {
  it('สร้างรอบพิมพ์ จองจดหมาย และวาดไฟล์ผ่านคิวงาน', async () => {
    const { client, inmate } = await relative()
    await grant(client, 'to_prison')
    const letter = await draftAndSubmit(client, inmate.inmateId, 'ขอให้พ่อรักษาสุขภาพนะคะ')

    const admin = await staffClient()
    const created = await admin.request(`${BASE}/admin/letters/batches`, {
      method: 'POST',
      json: { zoneId: null }
    })
    expect(created.status).toBe(201)
    const batch = (await created.json()) as any
    expect(batch.batchNo).toMatch(/^KLP-B\d{4}-\d{4}$/)
    expect(batch.letterCount).toBeGreaterThanOrEqual(1)
    expect(batch.status).toBe('queued')

    // The letter is pinned before the job runs — that is what stops two
    // operators printing the same letter twice.
    const pinned = (await admin.json(`${BASE}/admin/letters/${letter.id}`)) as any
    expect(pinned.status).toBe('pending_print')
    expect(pinned.batchNo).toBe(batch.batchNo)

    await drainJobs()
    const ready = (await admin.json(`${BASE}/admin/letters/batches/${batch.id}`)) as any
    expect(ready.status).toBe('ready')
    expect(ready.fileUrl).toBeTruthy()

    const file = await admin.request(`${BASE}/admin/letters/batches/${batch.id}/file`)
    expect(file.status).toBe(200)
    const document = await file.text()
    expect(document).toContain(letter.letterNo)
    expect(document).toContain('แบบฟอร์มตอบกลับ')
    // Every sheet carries its own reply QR as an embedded image.
    expect(document).toContain('data:image/png;base64,')

    const printed = (await admin.json(`${BASE}/admin/letters/batches/${batch.id}/printed`, {
      method: 'POST'
    })) as any
    expect(printed.status).toBe('printed')
    expect(((await admin.json(`${BASE}/admin/letters/${letter.id}`)) as any).status).toBe('printed')
  })

  it('ไม่มีจดหมายรอพิมพ์ = สร้างรอบไม่ได้', async () => {
    const admin = await staffClient()
    const res = await admin.request(`${BASE}/admin/letters/batches`, {
      method: 'POST',
      json: { zoneId: null }
    })
    expect(res.status).toBe(409)
  })

  it('เจ้าหน้าที่แดนสร้างรอบพิมพ์ไม่ได้ แต่ดูคิวได้', async () => {
    const zoneStaff = await staffClient('klp.zone')
    expect((await zoneStaff.request(`${BASE}/admin/letters`)).status).toBe(200)
    const res = await zoneStaff.request(`${BASE}/admin/letters/batches`, {
      method: 'POST',
      json: {}
    })
    expect(res.status).toBe(403)
  })

  it('คิวจดหมายถูกจำกัดขอบเขตตามเรือนจำ', async () => {
    const { client, inmate } = await relative()
    await grant(client, 'to_prison')
    const mine = await draftAndSubmit(client, inmate.inmateId)

    const other = await staffClient('bkw.admin')
    const page = (await other.json(`${BASE}/admin/letters`)) as any
    expect(page.items.every((l: any) => l.prisonName.includes('บางขวาง'))).toBe(true)
    expect((await other.request(`${BASE}/admin/letters/${mine.id}`)).status).toBe(403)
  })

  it('เจ้าหน้าที่ไม่อนุญาตจดหมาย = คืนสิทธิ์ให้ญาติ', async () => {
    const { client, inmate } = await relative()
    await grant(client, 'to_prison')
    const letter = await draftAndSubmit(client, inmate.inmateId, 'ข้อความที่จะถูกตีกลับ')
    const spent = (await client.json(`${BASE}/letters/credits`)) as any

    const admin = await staffClient()
    const rejected = (await admin.json(`${BASE}/admin/letters/${letter.id}/status`, {
      method: 'POST',
      json: { status: 'rejected', reason: 'มีข้อความต้องห้าม' }
    })) as any
    expect(rejected.status).toBe('rejected')
    expect(rejected.rejectedReason).toBe('มีข้อความต้องห้าม')

    const back = (await client.json(`${BASE}/letters/credits`)) as any
    expect(back.balance.toPrison).toBe(spent.balance.toPrison + 1)
  })

  it('ไม่อนุญาตต้องระบุเหตุผล และข้ามลำดับสถานะไม่ได้', async () => {
    const { client, inmate } = await relative()
    await grant(client, 'to_prison')
    const letter = await draftAndSubmit(client, inmate.inmateId)
    const admin = await staffClient()

    const noReason = await admin.request(`${BASE}/admin/letters/${letter.id}/status`, {
      method: 'POST',
      json: { status: 'rejected' }
    })
    expect(noReason.status).toBe(400)

    const tooFar = await admin.request(`${BASE}/admin/letters/${letter.id}/status`, {
      method: 'POST',
      json: { status: 'dispatched' }
    })
    expect(tooFar.status).toBe(409)
  })
})

/* ── scan-reply (p.6) ──────────────────────────────────────────────────── */

describe('การนำเข้าจดหมายตอบกลับด้วยการสแกน', () => {
  async function printedLetter(username = '0812345678') {
    const { client, inmate } = await relative(username)
    await grant(client, 'to_prison')
    const letter = await draftAndSubmit(client, inmate.inmateId, 'ถึงพ่อ คิดถึงนะคะ')
    const admin = await staffClient()
    const batch = (await admin.json(`${BASE}/admin/letters/batches`, {
      method: 'POST',
      json: {}
    })) as any
    await drainJobs()
    await admin.json(`${BASE}/admin/letters/batches/${batch.id}/printed`, { method: 'POST' })
    return { client, admin, letter }
  }

  it('อ่าน QR บนใบสแกน แล้วผูกคำตอบกลับเข้ากับจดหมายต้นทาง', async () => {
    const { client, admin, letter } = await printedLetter()
    await grant(client, 'to_home')

    const res = await upload(
      admin,
      '/admin/letters/scan-reply',
      await scanSheet(letter.letterNo),
      'scan.jpg'
    )
    expect(res.status).toBe(201)
    const result = (await res.json()) as any
    expect(result.matchedLetterNo).toBe(letter.letterNo)
    expect(result.awaitingCredit).toBe(false)
    expect(result.letter.direction).toBe('to_home')
    expect(result.letter.replyToLetterNo).toBe(letter.letterNo)
    expect(result.letter.status).toBe('delivered')

    // The relative sees it in their own list, and the outgoing letter is now
    // provably delivered — the inmate wrote on it.
    const mine = (await client.json(`${BASE}/letters?direction=to_home`)) as any
    expect(mine.items.some((l: any) => l.id === result.letter.id)).toBe(true)
    expect(((await client.json(`${BASE}/letters/${letter.id}`)) as any).status).toBe('delivered')

    const scan = await client.request(`${BASE}/letters/${result.letter.id}/scan`)
    expect(scan.status).toBe(200)
  })

  it('ไม่มีสิทธิ์ "ส่งกลับบ้าน" = เก็บสแกนไว้ก่อน แล้วปลดล็อกเมื่อซื้อแพ็กเกจ', async () => {
    const { client, admin, letter } = await printedLetter('0823456789')

    const res = await upload(
      admin,
      '/admin/letters/scan-reply',
      await scanSheet(letter.letterNo),
      'scan.jpg'
    )
    const result = (await res.json()) as any
    expect(result.awaitingCredit).toBe(true)
    expect(result.letter.status).toBe('queued')

    // Sealed until paid for — the scan exists but the family cannot open it.
    expect((await client.request(`${BASE}/letters/${result.letter.id}/scan`)).status).toBe(403)

    await grant(client, 'to_home')
    const unlocked = (await client.json(`${BASE}/letters/${result.letter.id}`)) as any
    expect(unlocked.status).toBe('delivered')
    expect((await client.request(`${BASE}/letters/${result.letter.id}/scan`)).status).toBe(200)
  })

  it('สแกนซ้ำถูกปฏิเสธ', async () => {
    const { client, admin, letter } = await printedLetter()
    await grant(client, 'to_home')
    await upload(admin, '/admin/letters/scan-reply', await scanSheet(letter.letterNo), 's.jpg')
    const again = await upload(
      admin,
      '/admin/letters/scan-reply',
      await scanSheet(letter.letterNo),
      's.jpg'
    )
    expect(again.status).toBe(409)
  })

  it('QR อ่านไม่ออก = บอกให้กรอกเลขที่เอง และเลขที่ที่กรอกใช้ได้', async () => {
    const { client, admin, letter } = await printedLetter()
    await grant(client, 'to_home')
    const blank = await sharp({
      create: { width: 1000, height: 1400, channels: 3, background: '#ffffff' }
    })
      .jpeg()
      .toBuffer()
    const blob = new Blob([new Uint8Array(blank)], { type: 'image/jpeg' })

    const unreadable = await upload(admin, '/admin/letters/scan-reply', blob, 'blank.jpg')
    const noQr = (await unreadable.json()) as any
    expect(noQr.matchedLetterNo).toBeNull()
    expect(noQr.letter).toBeNull()

    const typed = await upload(admin, '/admin/letters/scan-reply', blob, 'blank.jpg', {
      letterNo: letter.letterNo
    })
    expect(typed.status).toBe(201)
    expect(((await typed.json()) as any).letter.replyToLetterNo).toBe(letter.letterNo)
  })

  it('เลขที่จดหมายที่ไม่มีในระบบถูกรายงานกลับ ไม่ใช่ 500', async () => {
    const admin = await staffClient()
    const blank = await sharp({
      create: { width: 800, height: 1000, channels: 3, background: '#ffffff' }
    })
      .jpeg()
      .toBuffer()
    const res = await upload(
      admin,
      '/admin/letters/scan-reply',
      new Blob([new Uint8Array(blank)], { type: 'image/jpeg' }),
      'x.jpg',
      { letterNo: 'KLP-L9999-9999' }
    )
    expect(res.status).toBe(201)
    const body = (await res.json()) as any
    expect(body.letter).toBeNull()
    expect(body.message).toContain('KLP-L9999-9999')
  })
})

/* ── totals ────────────────────────────────────────────────────────────── */

describe('ยอดรวมจดหมาย', () => {
  it('ยอดรวมตรงกับรายการในคิว', async () => {
    const admin = await staffClient('klp.admin')
    const totals = (await admin.json(`${BASE}/admin/letters/summary`)) as any
    const queue = (await admin.json(`${BASE}/admin/letters?limit=100`)) as any

    const awaiting = queue.items.filter((l: any) =>
      ['queued', 'pending_print'].includes(l.status)
    ).length
    expect(totals.awaitingPrintCount).toBe(awaiting)
    expect(totals.buckets.reduce((n: number, b: any) => n + b.count, 0)).toBe(queue.items.length)
    expect(totals.creditsSoldSatang).toBeGreaterThan(0)
  })
})
