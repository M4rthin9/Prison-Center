import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import type { ImportPreview, ImportRunSummary, InmateRow } from '@pc/contract'
import { BASE, loginStaff, setupApp } from './helpers.js'

const ctx = setupApp()

interface Page<T> {
  items: T[]
  nextCursor: string | null
}

async function admin(username = 'klp.admin') {
  const { client } = await loginStaff(ctx.app, username)
  return client
}

async function prisonId(code: 'KLP' | 'BKW') {
  const client = await admin('superadmin')
  const { items } = await client.json<{ items: { id: string; code: string }[] }>(
    `${BASE}/prisons`
  )
  return items.find((p) => p.code === code)!.id
}

/* ── file builders ─────────────────────────────────────────────────────── */

const HEADERS = ['รหัสอ้างอิง', 'เลขทะเบียน', 'ชื่อ-สกุล', 'แดน', 'กองงาน', 'สถานะ']

interface Row {
  externalId?: string
  code: string
  name: string
  zone?: string
  division?: string
  status?: string
}

function csv(rows: Row[], headers = HEADERS): Buffer {
  const lines = [headers.join(',')]
  for (const r of rows) {
    lines.push(
      [
        r.externalId ?? '',
        r.code,
        `"${r.name}"`,
        r.zone ?? '',
        r.division ?? '',
        r.status ?? 'ปกติ'
      ].join(',')
    )
  }
  return Buffer.from(lines.join('\n'), 'utf8')
}

async function xlsx(rows: Row[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const sheet = wb.addWorksheet('รายชื่อ')
  // A merged title row above the header is what the DOC export actually looks
  // like — the parser has to find the header row on its own.
  sheet.addRow(['บัญชีผู้ต้องขัง ประจำเดือน'])
  sheet.addRow(HEADERS)
  for (const r of rows) {
    sheet.addRow([
      r.externalId ?? '',
      r.code,
      r.name,
      r.zone ?? '',
      r.division ?? '',
      r.status ?? 'ปกติ'
    ])
  }
  return Buffer.from(await wb.xlsx.writeBuffer())
}

async function upload(
  client: Awaited<ReturnType<typeof admin>>,
  buffer: Buffer,
  filename: string,
  extra: Record<string, string> = {}
) {
  const form = new FormData()
  form.append('file', new Blob([new Uint8Array(buffer)]), filename)
  for (const [k, v] of Object.entries(extra)) form.append(k, v)
  const res = await client.request(`${BASE}/admin/inmates/import`, { method: 'POST', body: form })
  return { status: res.status, body: (await res.json()) as ImportPreview }
}

async function importFile(
  client: Awaited<ReturnType<typeof admin>>,
  buffer: Buffer,
  filename: string,
  extra: Record<string, string> = {}
) {
  const dry = await upload(client, buffer, filename, extra)
  expect(dry.status).toBe(200)
  const applied = await client.json<ImportPreview>(
    `${BASE}/admin/inmates/import/${dry.body.run.id}/apply`,
    { method: 'POST' }
  )
  return { dry: dry.body, applied }
}

function findInmate(client: Awaited<ReturnType<typeof admin>>, q: string) {
  return client.json<Page<InmateRow>>(`${BASE}/admin/inmates?q=${encodeURIComponent(q)}`)
}

/* ── CRUD ──────────────────────────────────────────────────────────────── */

describe('inmate CRUD', () => {
  it('lists the seeded roster scoped to the caller’s prison', async () => {
    const client = await admin()
    const page = await client.json<Page<InmateRow>>(`${BASE}/admin/inmates?limit=100`)
    expect(page.items.length).toBe(10)
    expect(page.items.every((i) => i.prisonName.includes('คลองเปรม'))).toBe(true)
    // Sorted by registration number, which is how a clerk reads the list.
    const codes = page.items.map((i) => i.inmateCode)
    expect([...codes].sort()).toEqual(codes)
  })

  it('refuses a prison admin reading another facility’s inmate', async () => {
    const klp = await admin()
    const bkw = await admin('bkw.admin')
    const mine = (await klp.json<Page<InmateRow>>(`${BASE}/admin/inmates`)).items[0]!
    const res = await bkw.request(`${BASE}/admin/inmates/${mine.id}`)
    expect(res.status).toBe(403)
  })

  it('creates, edits and marks the row locally edited', async () => {
    const client = await admin()
    const created = await client.json<InmateRow>(`${BASE}/admin/inmates`, {
      method: 'POST',
      json: { inmateCode: 'KLP-68-9001', fullName: 'ทดสอบ ระบบ' }
    })
    expect(created.isLocallyEdited).toBe(true)
    expect(created.linkCount).toBe(0)

    const updated = await client.json<InmateRow>(`${BASE}/admin/inmates/${created.id}`, {
      method: 'PATCH',
      json: { fullName: 'ทดสอบ แก้ไขแล้ว' }
    })
    expect(updated.fullName).toBe('ทดสอบ แก้ไขแล้ว')
  })

  it('refuses a duplicate registration number in the same prison', async () => {
    const client = await admin()
    const existing = (await client.json<Page<InmateRow>>(`${BASE}/admin/inmates`)).items[0]!
    const res = await client.request(`${BASE}/admin/inmates`, {
      method: 'POST',
      json: { inmateCode: existing.inmateCode, fullName: 'ซ้ำ ทะเบียน' }
    })
    expect(res.status).toBe(409)
  })

  it('refuses zone_staff writing master data', async () => {
    const client = await admin('klp.zone')
    const res = await client.request(`${BASE}/admin/inmates`, {
      method: 'POST',
      json: { inmateCode: 'KLP-68-9002', fullName: 'ไม่มีสิทธิ์ เขียน' }
    })
    expect(res.status).toBe(403)
  })

  it('soft-deletes, hides from the default list, and restores', async () => {
    const client = await admin()
    const created = await client.json<InmateRow>(`${BASE}/admin/inmates`, {
      method: 'POST',
      json: { inmateCode: 'KLP-68-9003', fullName: 'ลบ ทดสอบ' }
    })
    const deleted = await client.json<InmateRow>(`${BASE}/admin/inmates/${created.id}`, {
      method: 'DELETE'
    })
    expect(deleted.deletedAt).not.toBeNull()

    const hidden = await findInmate(client, 'KLP-68-9003')
    expect(hidden.items).toHaveLength(0)
    const shown = await client.json<Page<InmateRow>>(
      `${BASE}/admin/inmates?q=KLP-68-9003&includeDeleted=true`
    )
    expect(shown.items).toHaveLength(1)

    const restored = await client.json<InmateRow>(
      `${BASE}/admin/inmates/${created.id}/restore`,
      { method: 'POST' }
    )
    expect(restored.deletedAt).toBeNull()
  })

  it('refuses to delete an inmate with an unpaid order', async () => {
    const client = await admin()
    const withOrder = (await client.json<Page<InmateRow>>(`${BASE}/admin/inmates?limit=100`)).items
    // The seed places two unpaid orders against the first two KLP inmates.
    const res = await client.request(`${BASE}/admin/inmates/${withOrder[0]!.id}`, {
      method: 'DELETE'
    })
    expect(res.status).toBe(409)
  })

  it('moves an inmate between facilities without touching past orders', async () => {
    const client = await admin('superadmin')
    const bkw = await prisonId('BKW')
    const created = await client.json<InmateRow>(`${BASE}/admin/inmates`, {
      method: 'POST',
      json: { prisonId: await prisonId('KLP'), inmateCode: 'KLP-68-9100', fullName: 'ย้าย ทดสอบ' }
    })
    const moved = await client.json<InmateRow>(`${BASE}/admin/inmates/${created.id}/transfer`, {
      method: 'POST',
      json: { toPrisonId: bkw, reason: 'ย้ายตามคำสั่ง' }
    })
    expect(moved.prisonId).toBe(bkw)
    expect(moved.zoneId).toBeNull()
    expect(moved.status).toBe('active')
  })

  it('refuses a prison admin transferring someone into another facility', async () => {
    const client = await admin()
    const mine = (await client.json<Page<InmateRow>>(`${BASE}/admin/inmates`)).items[0]!
    const res = await client.request(`${BASE}/admin/inmates/${mine.id}/transfer`, {
      method: 'POST',
      json: { toPrisonId: await prisonId('BKW') }
    })
    expect(res.status).toBe(403)
  })
})

/* ── import ────────────────────────────────────────────────────────────── */

describe('inmate import', () => {
  it('previews without writing anything', async () => {
    const client = await admin()
    const before = await findInmate(client, 'IMP-01')
    expect(before.items).toHaveLength(0)

    const { status, body } = await upload(
      client,
      csv([{ externalId: 'KLPX0001', code: 'IMP-01', name: 'นำเข้า หนึ่ง', zone: 'แดน 1' }]),
      'roster.csv'
    )
    expect(status).toBe(200)
    expect(body.run.status).toBe('dry_run')
    expect(body.run.rowsCreated).toBe(1)
    expect((await findInmate(client, 'IMP-01')).items).toHaveLength(0)
  })

  it('imports an XLSX with a title row above the header', async () => {
    const client = await admin()
    const { applied } = await importFile(
      client,
      await xlsx([
        { externalId: 'KLPX0010', code: 'IMP-10', name: 'เอ็กเซล หนึ่ง', zone: 'แดน 2' },
        { externalId: 'KLPX0011', code: 'IMP-11', name: 'เอ็กเซล สอง', zone: 'แดน 3' }
      ]),
      'roster.xlsx'
    )
    expect(applied.run.status).toBe('applied')
    expect(applied.run.rowsCreated).toBe(2)
    const found = await findInmate(client, 'IMP-1')
    expect(found.items.map((i) => i.zoneName)).toEqual(['แดน 2', 'แดน 3'])
  })

  it('imports the same file twice with zero duplicates and an empty diff', async () => {
    const client = await admin()
    const file = csv([
      { externalId: 'KLPX0020', code: 'IMP-20', name: 'ซ้ำ หนึ่ง', zone: 'แดน 1' },
      { externalId: 'KLPX0021', code: 'IMP-21', name: 'ซ้ำ สอง', zone: 'แดน 2' }
    ])
    const first = await importFile(client, file, 'roster.csv')
    expect(first.applied.run.rowsCreated).toBe(2)

    const second = await importFile(client, file, 'roster.csv')
    expect(second.applied.run.rowsCreated).toBe(0)
    expect(second.applied.run.rowsUpdated).toBe(0)
    expect(second.applied.run.rowsSkipped).toBe(2)
    expect((await findInmate(client, 'IMP-2')).items).toHaveLength(2)
  })

  it('reads TIS-620 without mojibake', async () => {
    const client = await admin()
    // windows-874 is TIS-620 plus the Windows extras; Node decodes both.
    const utf8 = csv([{ externalId: 'KLPX0030', code: 'IMP-30', name: 'ไทยแลนด์ ทดสอบ' }])
    const legacy = Buffer.from(
      [...utf8.toString('utf8')]
        .map((ch) => {
          const cp = ch.codePointAt(0)!
          return cp >= 0x0e00 && cp <= 0x0e5b ? cp - 0x0e00 + 0xa0 : cp
        })
        .filter((b) => b < 256)
    )
    const { applied } = await importFile(client, legacy, 'roster.csv')
    expect(applied.run.rowsCreated).toBe(1)
    expect((await findInmate(client, 'IMP-30')).items[0]!.fullName).toBe('ไทยแลนด์ ทดสอบ')
  })

  it('reports a name change as an update and leaves a corrected name alone', async () => {
    const client = await admin()
    await importFile(
      client,
      csv([{ externalId: 'KLPX0040', code: 'IMP-40', name: 'ชื่อ เดิม' }]),
      'roster.csv'
    )
    const row = (await findInmate(client, 'IMP-40')).items[0]!
    expect(row.isLocallyEdited).toBe(false)

    const renamed = await importFile(
      client,
      csv([{ externalId: 'KLPX0040', code: 'IMP-40', name: 'ชื่อ ใหม่' }]),
      'roster.csv'
    )
    expect(renamed.applied.run.rowsUpdated).toBe(1)
    expect((await findInmate(client, 'IMP-40')).items[0]!.fullName).toBe('ชื่อ ใหม่')

    // A staff correction now outranks the file for the name — but not the zone.
    await client.json(`${BASE}/admin/inmates/${row.id}`, {
      method: 'PATCH',
      json: { fullName: 'ชื่อ ที่เจ้าหน้าที่แก้' }
    })
    const third = await importFile(
      client,
      csv([{ externalId: 'KLPX0040', code: 'IMP-40', name: 'ชื่อ จากไฟล์', zone: 'แดน 6' }]),
      'roster.csv'
    )
    expect(third.applied.run.rowsUpdated).toBe(1)
    const after = (await findInmate(client, 'IMP-40')).items[0]!
    expect(after.fullName).toBe('ชื่อ ที่เจ้าหน้าที่แก้')
    expect(after.zoneName).toBe('แดน 6')
  })

  it('flags an unknown zone as a conflict, and creates it when asked', async () => {
    const client = await admin()
    const file = csv([{ externalId: 'KLPX0050', code: 'IMP-50', name: 'แดน ใหม่', zone: 'แดน 99' }])

    const strict = await upload(client, file, 'roster.csv')
    expect(strict.body.run.rowsErrored).toBe(1)
    expect(strict.body.rows[0]!.result).toBe('conflict')
    expect(strict.body.rows[0]!.message).toContain('แดน 99')

    const lenient = await importFile(client, file, 'roster.csv', { createZones: 'true' })
    expect(lenient.applied.run.rowsCreated).toBe(1)
    expect((await findInmate(client, 'IMP-50')).items[0]!.zoneName).toBe('แดน 99')
  })

  it('rejects a row twice in one file and a code that belongs to somebody else', async () => {
    const client = await admin()
    const dup = await upload(
      client,
      csv([
        { externalId: 'KLPX0060', code: 'IMP-60', name: 'หนึ่ง' },
        { externalId: 'KLPX0060', code: 'IMP-61', name: 'สอง' }
      ]),
      'roster.csv'
    )
    expect(dup.body.run.rowsErrored).toBe(1)
    expect(dup.body.rows[0]!.message).toContain('รหัสอ้างอิงซ้ำ')

    await importFile(
      client,
      csv([{ externalId: 'KLPX0070', code: 'IMP-70', name: 'เจ้าของ เลข' }]),
      'roster.csv'
    )
    const stolen = await upload(
      client,
      csv([{ externalId: 'KLPX0071', code: 'IMP-70', name: 'ขโมย เลข' }]),
      'roster.csv'
    )
    expect(stolen.body.rows[0]!.result).toBe('conflict')
  })

  it('errors a row with no name and one with an unreadable status', async () => {
    const client = await admin()
    const { body } = await upload(
      client,
      csv([
        { externalId: 'KLPX0080', code: 'IMP-80', name: '' },
        { externalId: 'KLPX0081', code: 'IMP-81', name: 'สถานะ พัง', status: 'ลาพักร้อน' }
      ]),
      'roster.csv'
    )
    expect(body.run.rowsErrored).toBe(2)
    expect(body.rows.every((r) => r.result === 'error')).toBe(true)
  })

  it('serves an XLSX error report for the rows a clerk must fix', async () => {
    const client = await admin()
    const { body } = await upload(
      client,
      csv([{ externalId: 'KLPX0090', code: 'IMP-90', name: 'ไม่มีแดน', zone: 'แดน 98' }]),
      'roster.csv'
    )
    expect(body.run.hasErrorReport).toBe(true)

    const res = await client.request(
      `${BASE}/admin/inmates/import-runs/${body.run.id}/errors.xlsx`
    )
    expect(res.status).toBe(200)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(await res.arrayBuffer())
    const sheet = wb.worksheets[0]!
    expect(String(sheet.getRow(1).getCell(3).value)).toBe('สาเหตุ')
    expect(String(sheet.getRow(2).getCell(3).value)).toContain('แดน 98')
  })

  it('moves an inmate in when the receiving facility imports them', async () => {
    const client = await admin('superadmin')
    const klp = await prisonId('KLP')
    const bkw = await prisonId('BKW')

    await importFile(
      client,
      csv([{ externalId: 'KLPX0100', code: 'IMP-100', name: 'ย้าย ข้ามเรือนจำ' }]),
      'roster.csv',
      { prisonId: klp }
    )
    const moved = await importFile(
      client,
      csv([{ externalId: 'KLPX0100', code: 'IMP-100', name: 'ย้าย ข้ามเรือนจำ', zone: 'แดน 1' }]),
      'roster.csv',
      { prisonId: bkw }
    )
    expect(moved.applied.run.rowsUpdated).toBe(1)
    expect(moved.dry.rows[0]!.message).toContain('ย้ายมาจาก')

    const found = await client.json<Page<InmateRow>>(`${BASE}/admin/inmates?q=IMP-100`)
    expect(found.items).toHaveLength(1)
    expect(found.items[0]!.prisonId).toBe(bkw)
  })

  it('never releases the roster implicitly, and marks it transferred only on request', async () => {
    const client = await admin('bkw.admin')
    const roster = await client.json<Page<InmateRow>>(`${BASE}/admin/inmates?limit=100`)
    const first = roster.items[0]!

    // A one-row file naming a single inmate: everyone else is "missing".
    const partial = csv([{ externalId: 'BKW000001', code: first.inmateCode, name: first.fullName }])
    const ignored = await importFile(client, partial, 'roster.csv')
    expect(ignored.dry.missingTotal).toBeGreaterThan(0)
    const stillActive = await client.json<Page<InmateRow>>(
      `${BASE}/admin/inmates?status=active&limit=100`
    )
    expect(stillActive.items.length).toBe(roster.items.length)

    const swept = await importFile(client, partial, 'roster.csv', {
      missingPolicy: 'mark_transferred'
    })
    expect(swept.applied.missingTotal).toBeGreaterThan(0)
    const after = await client.json<Page<InmateRow>>(
      `${BASE}/admin/inmates?status=transferred&limit=100`
    )
    expect(after.items.length).toBe(swept.applied.missingTotal)
    // Marked, never deleted — every row is still there.
    const all = await client.json<Page<InmateRow>>(`${BASE}/admin/inmates?limit=100`)
    expect(all.items.length).toBeGreaterThanOrEqual(roster.items.length)
  })

  it('refuses to apply the same run twice', async () => {
    const client = await admin()
    const { dry } = await importFile(
      client,
      csv([{ externalId: 'KLPX0110', code: 'IMP-110', name: 'ยืนยัน ซ้ำ' }]),
      'roster.csv'
    )
    const res = await client.request(`${BASE}/admin/inmates/import/${dry.run.id}/apply`, {
      method: 'POST'
    })
    expect(res.status).toBe(409)
  })

  it('rejects a file with no usable columns', async () => {
    const client = await admin()
    const res = await upload(
      client,
      Buffer.from('อำเภอ,จังหวัด\nเมือง,นนทบุรี', 'utf8'),
      'wrong.csv'
    )
    expect(res.status).toBe(400)
  })

  it('keeps a facility’s import history in its own scope', async () => {
    const klp = await admin()
    const bkw = await admin('bkw.admin')
    const runs = await klp.json<{ items: ImportRunSummary[] }>(
      `${BASE}/admin/inmates/import-runs`
    )
    expect(runs.items.length).toBeGreaterThan(0)
    expect(runs.items.every((r) => r.prisonName.includes('คลองเปรม'))).toBe(true)

    const res = await bkw.request(`${BASE}/admin/inmates/import-runs/${runs.items[0]!.id}`)
    expect(res.status).toBe(403)
  })
})
