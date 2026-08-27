import { describe, expect, it } from 'vitest'
import { BASE, loginCustomer, loginStaff, setupApp } from './helpers.js'

const ctx = setupApp()
const app = () => ctx.app

async function setSetting(key: string, value: unknown) {
  const { client } = await loginStaff(app())
  const res = await client.request(`${BASE}/admin/settings/${key}`, { method: 'PUT', json: { value } })
  expect(res.status).toBe(200)
}

describe('PDPA retention', () => {
  it('previews without deleting anything, whatever the settings say', async () => {
    const { client } = await loginStaff(app())
    const report = (await client.json(`${BASE}/admin/pdpa/retention/preview`)) as any

    expect(report.dryRun).toBe(true)
    expect(report.enabled).toBe(false)
    // Every declared window is accounted for, so the report is a complete
    // answer to "what would this remove".
    expect(report.actions.map((a: any) => a.key)).toEqual([
      'letters.content',
      'payments.slips',
      'financial.records',
      'visits.bookings',
      'audit.logs',
      'accounts.anonymize',
      'housekeeping'
    ])
    for (const action of report.actions) expect(action.cutoffAt).toBeLessThan(Date.now())
  })

  it('is department-wide: only a super_admin may look at it', async () => {
    const { client } = await loginStaff(app(), 'klp.admin')
    expect((await client.request(`${BASE}/admin/pdpa/retention/preview`)).status).toBe(403)
  })

  it('refuses a real purge until the windows are signed off', async () => {
    const { client } = await loginStaff(app())
    const res = await client.request(`${BASE}/admin/pdpa/retention/run`, {
      method: 'POST',
      json: { dryRun: false }
    })
    expect(res.status).toBe(403)
  })

  it('falls back to dry-run when the job is asked to run with the switch off', async () => {
    const { client } = await loginStaff(app())
    const report = (await client.json(`${BASE}/admin/pdpa/retention/run`, {
      method: 'POST',
      json: {}
    })) as any
    expect(report.dryRun).toBe(true)
    expect(report.totalRows).toBe(0)
  })

  it('anonymizes a closed account instead of deleting it, once the window passes', async () => {
    const { db } = await import('../src/db/client.js')
    const { customers } = await import('../src/db/schema/index.js')
    const { eq } = await import('drizzle-orm')
    const { runRetention } = await import('../src/modules/pdpa/service.js')

    const { client } = await loginCustomer(app(), '0834567890')
    const me = (await client.json(`${BASE}/me`)) as any

    expect((await client.request(`${BASE}/me/close-account`, { method: 'POST' })).status).toBe(204)

    // Closing is immediate; the scrub waits out the window, so backdate it.
    const longAgo = Date.now() - 200 * 24 * 60 * 60 * 1000
    db().update(customers).set({ closedAt: longAgo }).where(eq(customers.id, me.id)).run()

    const dry = await runRetention({ dryRun: true, db: db() })
    expect(dry.actions.find((a) => a.key === 'accounts.anonymize')?.rows).toBe(1)
    expect(db().select().from(customers).where(eq(customers.id, me.id)).get()?.fullName).toBe(
      me.fullName
    )

    await setSetting('pdpa.retention.enabled', true)
    await setSetting('pdpa.retention.dry_run', false)
    const real = await runRetention({ db: db() })
    expect(real.dryRun).toBe(false)

    const row = db().select().from(customers).where(eq(customers.id, me.id)).get()!
    // The row is still there — financial history keeps its foreign key — but
    // nothing personal is left on it.
    expect(row.username).toBe(`deleted-${me.id}`)
    expect(row.fullName).not.toBe(me.fullName)
    expect(row.phone).toBe('')
    expect(row.anonymizedAt).toBeTypeOf('number')

    // Idempotent: a second pass finds nothing left to do.
    const again = await runRetention({ db: db() })
    expect(again.actions.find((a) => a.key === 'accounts.anonymize')?.rows).toBe(0)
  })

  it('cuts every session the moment an account is closed', async () => {
    const { client } = await loginCustomer(app(), '0845678901')
    expect((await client.request(`${BASE}/me`)).status).toBe(200)
    await client.request(`${BASE}/me/close-account`, { method: 'POST' })

    expect((await client.request(`${BASE}/auth/refresh`, { method: 'POST' })).status).toBe(401)
    // The account is blocked too, so the access token stops working as well.
    expect((await client.request(`${BASE}/me`)).status).toBe(403)
  })
})
