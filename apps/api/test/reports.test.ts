import { describe, expect, it } from 'vitest'
import { BASE, loginStaff, setupApp } from './helpers.js'

const ctx = setupApp()
const app = () => ctx.app

const { REPORT_LABEL } = await import('@pc/contract')
const { drainJobs } = await import('../src/lib/jobs/scheduler.js')
const { REPORTS } = await import('../src/modules/reports/definitions.js')
const { reportParams, runReportQuery, thaiPeriod, thaiDateTime } = await import(
  '../src/modules/reports/service.js'
)
const { bangkokDate } = await import('../src/lib/time.js')
const { sqlite } = await import('../src/db/client.js')

const KINDS = Object.keys(REPORTS) as (keyof typeof REPORTS)[]

/** The seed spreads three months of history; this covers all of it. */
const RANGE = { from: '2020-01-01', to: bangkokDate(), groupBy: 'month' as const }

const finance = async () => (await loginStaff(app(), 'klp.finance')).client
const boss = async () => (await loginStaff(app(), 'superadmin')).client

/* ── the raw SQL ───────────────────────────────────────────────────────── */

describe('report queries', () => {
  it.each(KINDS)('%s runs against a real database', (kind) => {
    const rows = runReportQuery(kind, reportParams(RANGE, null), sqlite())
    expect(Array.isArray(rows)).toBe(true)
    // Every column the sheet declares must actually come back from the SQL,
    // otherwise the XLSX quietly ships a column of dashes.
    if (rows.length > 0) {
      for (const column of REPORTS[kind].columns) {
        expect(Object.keys(rows[0]!)).toContain(column.key)
      }
    }
  })

  it('binds only the parameters a query actually mentions', () => {
    // `visits.sql` has no :shop_id — better-sqlite3 throws on an extra name,
    // which is exactly the failure this guards.
    expect(() => runReportQuery('visits', reportParams(RANGE, null), sqlite())).not.toThrow()
  })

  it('scopes rows to one prison when a prison id is bound', () => {
    const all = runReportQuery('sales', reportParams(RANGE, null), sqlite())
    expect(all.length).toBeGreaterThan(0)

    const one = all[0]!.prisonName
    const prison = sqlite().prepare('select id from prisons where name_th = ?').get(one) as {
      id: string
    }
    const scoped = runReportQuery('sales', reportParams(RANGE, prison.id), sqlite())
    expect(scoped.length).toBeGreaterThan(0)
    expect(scoped.length).toBeLessThanOrEqual(all.length)
    expect(new Set(scoped.map((r) => r.prisonName))).toEqual(new Set([one]))

    // …and a prison with no orders comes back empty rather than borrowing rows.
    const others = sqlite()
      .prepare('select id from prisons where name_th <> ?')
      .all(one) as { id: string }[]
    for (const other of others) {
      const rows = runReportQuery('sales', reportParams(RANGE, other.id), sqlite())
      expect(rows.every((r) => r.prisonName !== one)).toBe(true)
    }
  })
})

/* ── formatting ────────────────────────────────────────────────────────── */

describe('report formatting', () => {
  it('renders periods in Buddhist years', () => {
    expect(thaiPeriod('2026-08')).toBe('ส.ค. 2569')
    expect(thaiPeriod('2026')).toBe('2569')
    expect(thaiPeriod('ทั้งช่วง')).toBe('ทั้งช่วง')
  })

  it('renders timestamps in Bangkok time with a Buddhist year', () => {
    // 2026-08-26T17:00:00Z is 2026-08-27 00:00 in Bangkok.
    expect(thaiDateTime(Date.parse('2026-08-26T17:00:00Z'))).toBe('27/08/2569 00:00')
    expect(thaiDateTime(null)).toBe('-')
  })
})

/* ── the job round trip ────────────────────────────────────────────────── */

describe('report jobs', () => {
  it.each(KINDS)('queues %s, generates the XLSX, and serves it', async (kind) => {
    const staff = await finance()
    const queued = (await staff.json(`${BASE}/admin/reports/${kind}`, {
      method: 'POST',
      json: RANGE
    })) as any
    expect(queued.status).toBe('pending')
    expect(queued.label).toBe(REPORT_LABEL[kind])

    await drainJobs()

    const done = (await staff.json(`${BASE}/admin/reports/${queued.id}`)) as any
    expect(done.status).toBe('succeeded')
    expect(done.rowCount).toBeGreaterThanOrEqual(0)
    expect(done.filename).toContain('.xlsx')

    const file = await staff.request(`${BASE}/admin/reports/${queued.id}/download`)
    expect(file.status).toBe(200)
    const body = Buffer.from(await file.arrayBuffer())
    // A real xlsx is a zip: `PK`.
    expect(body.subarray(0, 2).toString()).toBe('PK')
    expect(body.byteLength).toBeGreaterThan(1000)
  })

  it('refuses to download a report that has not run yet', async () => {
    const staff = await finance()
    const queued = (await staff.json(`${BASE}/admin/reports/sales`, {
      method: 'POST',
      json: RANGE
    })) as any
    const res = await staff.request(`${BASE}/admin/reports/${queued.id}/download`)
    expect(res.status).toBe(400)
    await drainJobs()
  })

  it('rejects a reversed date range before a job row exists', async () => {
    const staff = await finance()
    const res = await staff.request(`${BASE}/admin/reports/sales`, {
      method: 'POST',
      json: { from: '2026-08-31', to: '2026-08-01', groupBy: 'month' }
    })
    expect(res.status).toBe(400)
  })

  it('hides another prison report from a prison-scoped account', async () => {
    const admin = await boss()
    const prisons = (await admin.json(`${BASE}/prisons`)) as any
    const other = prisons.items.find((p: any) => p.code !== 'KLP')
    const queued = (await admin.json(`${BASE}/admin/reports/sales`, {
      method: 'POST',
      json: { ...RANGE, prisonId: other.id }
    })) as any
    await drainJobs()

    const klp = await finance()
    expect((await klp.request(`${BASE}/admin/reports/${queued.id}`)).status).toBe(403)
    expect((await klp.request(`${BASE}/admin/reports/${queued.id}/download`)).status).toBe(403)

    const mine = (await klp.json(`${BASE}/admin/reports?limit=100`)) as any
    expect(mine.items.some((j: any) => j.id === queued.id)).toBe(false)
  })

  it('keeps a letter operator from exporting the department numbers', async () => {
    const { client } = await loginStaff(app(), 'klp.letters')
    const res = await client.request(`${BASE}/admin/reports/sales`, { method: 'POST', json: RANGE })
    expect(res.status).toBe(403)
  })
})

/* ── the dashboard ─────────────────────────────────────────────────────── */

describe('dashboard summary', () => {
  it('returns four tiles, one series point per day, and the work queues', async () => {
    const staff = await finance()
    const summary = (await staff.json(`${BASE}/admin/dashboard/summary?period=month`)) as any

    expect(summary.from.slice(-2)).toBe('01')
    expect(summary.to).toBe(bangkokDate())
    expect(summary.series.length).toBe(Number(bangkokDate().slice(-2)))
    expect(summary.prisonId).not.toBeNull()

    for (const tile of ['orders', 'visits', 'letters', 'deposits']) {
      expect(summary[tile].count).toBeGreaterThanOrEqual(0)
    }
    expect(summary.queues.paymentsAwaitingReview).toBeGreaterThanOrEqual(0)
  })

  it('agrees with the sales report over the same window', async () => {
    const staff = await finance()
    const summary = (await staff.json(
      `${BASE}/admin/dashboard/summary?period=custom&from=${RANGE.from}&to=${RANGE.to}`
    )) as any

    const rows = runReportQuery(
      'sales',
      reportParams({ ...RANGE, prisonId: summary.prisonId }, summary.prisonId),
      sqlite()
    )
    expect(rows.length).toBe(summary.orders.count)

    const paid = rows
      .filter((r) => r.paymentStatus === 'ชำระแล้ว')
      .reduce((acc, r) => acc + Number(r.totalSatang), 0)
    expect(paid).toBe(summary.orders.paidSatang)
  })

  it('refuses a custom period with no dates', async () => {
    const staff = await finance()
    expect((await staff.request(`${BASE}/admin/dashboard/summary?period=custom`)).status).toBe(400)
  })

  it('refuses to widen a prison account to another prison', async () => {
    const admin = await boss()
    const prisons = (await admin.json(`${BASE}/prisons`)) as any
    const other = prisons.items.find((p: any) => p.code !== 'KLP')
    const staff = await finance()
    const res = await staff.request(`${BASE}/admin/dashboard/summary?prisonId=${other.id}`)
    expect(res.status).toBe(403)
  })
})
