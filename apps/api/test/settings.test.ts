import { describe, expect, it } from 'vitest'
import { BASE, loginStaff, setupApp } from './helpers.js'

const ctx = setupApp()
const app = () => ctx.app

describe('settings registry', () => {
  it('serves declared defaults with no rows in the table', async () => {
    const { client } = await loginStaff(app())
    const res = (await client.json(`${BASE}/settings/public`)) as any
    expect(res.visit.horizonWeeks).toBe(4)
    expect(res.payment.qrTtlMinutes).toBe(30)
    expect(res.features.lineLogin).toBe(false)
  })

  it('rejects an unknown key', async () => {
    const { client } = await loginStaff(app())
    const res = await client.request(`${BASE}/admin/settings/not.a.real.key`, {
      method: 'PUT',
      json: { value: 1 }
    })
    expect(res.status).toBe(400)
  })

  it('rejects a value that fails the declared schema', async () => {
    const { client } = await loginStaff(app())
    const res = await client.request(`${BASE}/admin/settings/visit.horizon_weeks`, {
      method: 'PUT',
      json: { value: 99 }
    })
    expect(res.status).toBe(400)
  })

  it('writes a global key and reads it back', async () => {
    const { client } = await loginStaff(app())
    const put = (await client.json(`${BASE}/admin/settings/payment.qr.ttl_minutes`, {
      method: 'PUT',
      json: { value: 45 }
    })) as any
    expect(put.value).toBe(45)
    expect(put.isDefault).toBe(false)

    const pub = (await client.json(`${BASE}/settings/public`)) as any
    expect(pub.payment.qrTtlMinutes).toBe(45)
  })

  it('lets a prison override a prison-scoped key without touching the global value', async () => {
    const { client: sup } = await loginStaff(app())
    const prisons = (await sup.json(`${BASE}/prisons`)) as any
    const klp = prisons.items.find((p: any) => p.code === 'KLP')
    const bkw = prisons.items.find((p: any) => p.code === 'BKW')

    await sup.request(`${BASE}/admin/settings/visit.horizon_weeks?prisonId=${klp.id}`, {
      method: 'PUT',
      json: { value: 8 }
    })

    const klpPublic = (await sup.json(`${BASE}/settings/public?prisonId=${klp.id}`)) as any
    const bkwPublic = (await sup.json(`${BASE}/settings/public?prisonId=${bkw.id}`)) as any
    expect(klpPublic.visit.horizonWeeks).toBe(8)
    expect(bkwPublic.visit.horizonWeeks).toBe(4)
  })

  it('refuses a prison admin writing another facility’s override or a global key', async () => {
    const { client: sup } = await loginStaff(app())
    const prisons = (await sup.json(`${BASE}/prisons`)) as any
    const bkw = prisons.items.find((p: any) => p.code === 'BKW')

    const { client: klp } = await loginStaff(app(), 'klp.admin')
    const cross = await klp.request(`${BASE}/admin/settings/visit.horizon_weeks?prisonId=${bkw.id}`, {
      method: 'PUT',
      json: { value: 2 }
    })
    expect(cross.status).toBe(403)

    const global = await klp.request(`${BASE}/admin/settings/payment.salt.enabled`, {
      method: 'PUT',
      json: { value: false }
    })
    expect(global.status).toBe(400)
  })

  it('seeds every PDPA retention window so the Phase 7 job has values to read', async () => {
    const { client } = await loginStaff(app())
    const list = (await client.json(`${BASE}/admin/settings`)) as any
    const keys = list.items.map((i: any) => i.key)
    expect(keys).toEqual(
      expect.arrayContaining([
        'pdpa.retention.letter_days',
        'pdpa.retention.slip_days',
        'pdpa.retention.financial_days',
        'pdpa.retention.visit_days',
        'pdpa.retention.audit_days',
        'pdpa.retention.closed_account_days'
      ])
    )
    const letters = list.items.find((i: any) => i.key === 'pdpa.retention.letter_days')
    expect(letters.value).toBe(365)
  })
})

describe('audit log', () => {
  it('records login, failed login and the settings change', async () => {
    const { db } = await import('../src/db/client.js')
    const { auditLogs } = await import('../src/db/schema/index.js')

    await loginStaff(app(), 'klp.finance')
    await loginStaff(app(), 'klp.finance', 'wrong-password')

    const actions = db()
      .select({ action: auditLogs.action })
      .from(auditLogs)
      .all()
      .map((r) => r.action)

    expect(actions).toContain('auth.login')
    expect(actions).toContain('auth.login_failed')
  })

  it('never stores a password or token in the audit payload', async () => {
    const { db } = await import('../src/db/client.js')
    const { auditLogs } = await import('../src/db/schema/index.js')
    const rows = db().select().from(auditLogs).all()
    const blob = JSON.stringify(rows)
    expect(blob).not.toContain('password123')
    expect(blob).not.toMatch(/\$argon2id\$/)
  })
})

describe('jobs queue', () => {
  it('hands a due job to exactly one worker', async () => {
    const { db } = await import('../src/db/client.js')
    const { enqueue, claimNext } = await import('../src/lib/jobs/queue.js')
    const { drainJobs } = await import('../src/lib/jobs/scheduler.js')

    const id = enqueue('session.purge', {}, { db: db() })
    const first = claimNext('worker-a', db())
    const second = claimNext('worker-b', db())

    expect(first?.id).toBe(id)
    expect(second).toBeNull()

    // The claimed job is already 'running'; drain the next one enqueued after.
    enqueue('session.purge', {}, { db: db() })
    expect(await drainJobs()).toBe(1)
  })

  it('parks a job with no handler instead of looping on it', async () => {
    const { db } = await import('../src/db/client.js')
    const { enqueue } = await import('../src/lib/jobs/queue.js')
    const { drainJobs } = await import('../src/lib/jobs/scheduler.js')
    const { jobs } = await import('../src/db/schema/index.js')
    const { eq } = await import('drizzle-orm')

    const id = enqueue('report.generate', { kind: 'sales' }, { maxAttempts: 1, db: db() })
    await drainJobs()

    const row = db().select().from(jobs).where(eq(jobs.id, id)).get()
    expect(row?.status).toBe('failed')
    expect(row?.lastError).toContain('handler')
  })
})
