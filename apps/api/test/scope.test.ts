import { describe, expect, it } from 'vitest'
import { BASE, loginCustomer, loginStaff, setupApp } from './helpers.js'

const ctx = setupApp()
const app = () => ctx.app

async function prisonIdByCode(code: string) {
  const { client } = await loginStaff(app())
  const res = (await client.json(`${BASE}/prisons`)) as any
  return res.items.find((p: any) => p.code === code).id as string
}

describe('prison scoping', () => {
  it('reports department-wide scope for super_admin and a pinned prison for everyone else', async () => {
    const sup = await loginStaff(app(), 'superadmin')
    expect(((await sup.client.json(`${BASE}/admin/me`)) as any).prisonId).toBeNull()

    const klp = await loginStaff(app(), 'klp.admin')
    const me = (await klp.client.json(`${BASE}/admin/me`)) as any
    expect(me.prisonId).toBeTruthy()
    expect(me.prisonName).toContain('คลองเปรม')
  })

  it('refuses a cross-prison verification', async () => {
    // A relative linked to a Bang Kwang inmate.
    const { client: relative } = await loginCustomer(app(), '0834567890')
    const me = (await relative.json(`${BASE}/me`)) as any
    const bkwLink = me.inmates[0]
    expect(bkwLink).toBeTruthy()

    const { client: klp } = await loginStaff(app(), 'klp.admin')
    const res = await klp.request(`${BASE}/admin/customer-inmates/${bkwLink.id}/verify`, {
      method: 'POST',
      json: { status: 'verified' }
    })
    expect(res.status).toBe(403)

    // The facility that actually holds the inmate can.
    const { client: bkw } = await loginStaff(app(), 'bkw.admin')
    const ok = await bkw.request(`${BASE}/admin/customer-inmates/${bkwLink.id}/verify`, {
      method: 'POST',
      json: { status: 'verified' }
    })
    expect(ok.status).toBe(200)
  })

  it('keeps staff administration to super_admin', async () => {
    const { client: klp } = await loginStaff(app(), 'klp.admin')
    expect((await klp.request(`${BASE}/admin/staff`)).status).toBe(403)

    const { client: sup } = await loginStaff(app())
    expect((await sup.request(`${BASE}/admin/staff`)).status).toBe(200)
  })

  it('refuses a super_admin bound to a prison, and a prison role without one', async () => {
    const { client: sup } = await loginStaff(app())
    const klpId = await prisonIdByCode('KLP')

    const bound = await sup.request(`${BASE}/admin/staff`, {
      method: 'POST',
      json: {
        username: 'bad.super',
        fullName: 'ผิด กติกา',
        role: 'super_admin',
        prisonId: klpId
      }
    })
    expect(bound.status).toBe(400)

    const unbound = await sup.request(`${BASE}/admin/staff`, {
      method: 'POST',
      json: { username: 'bad.finance', fullName: 'ผิด กติกา', role: 'finance' }
    })
    expect(unbound.status).toBe(400)
  })

  it('creates staff with a forced password change and a one-time password', async () => {
    const { client: sup } = await loginStaff(app())
    const klpId = await prisonIdByCode('KLP')

    const created = (await sup.json(`${BASE}/admin/staff`, {
      method: 'POST',
      json: {
        username: 'klp.newstaff',
        fullName: 'เจ้าหน้าที่ใหม่',
        role: 'zone_staff',
        prisonId: klpId
      }
    })) as any
    expect(created.mustChangePassword).toBe(true)

    const login = await loginStaff(app(), 'klp.newstaff', created.oneTimePassword)
    expect(login.body.mustChangePassword).toBe(true)
    expect((await login.client.request(`${BASE}/admin/me`)).status).toBe(403)

    const changed = await login.client.request(`${BASE}/admin/auth/change-password`, {
      method: 'POST',
      json: { current: created.oneTimePassword, next: 'a-real-staff-password' }
    })
    expect(changed.status).toBe(200)
    login.client.token = ((await changed.json()) as any).accessToken
    expect((await login.client.request(`${BASE}/admin/me`)).status).toBe(200)
  })

  it('cuts off a deactivated staff account immediately', async () => {
    const { client: sup } = await loginStaff(app())
    const klpId = await prisonIdByCode('KLP')
    const created = (await sup.json(`${BASE}/admin/staff`, {
      method: 'POST',
      json: {
        username: 'klp.temp',
        fullName: 'ชั่วคราว ทดสอบ',
        role: 'finance',
        prisonId: klpId,
        password: 'temporary-password'
      }
    })) as any

    const temp = await loginStaff(app(), 'klp.temp', 'temporary-password')
    await temp.client.request(`${BASE}/admin/auth/change-password`, {
      method: 'POST',
      json: { current: 'temporary-password', next: 'settled-password' }
    })
    const active = await loginStaff(app(), 'klp.temp', 'settled-password')
    expect((await active.client.request(`${BASE}/admin/me`)).status).toBe(200)

    await sup.request(`${BASE}/admin/staff/${created.id}`, {
      method: 'PATCH',
      json: { isActive: false }
    })

    // The access token is still inside its 15-minute window and must fail anyway.
    expect((await active.client.request(`${BASE}/admin/me`)).status).toBe(403)
    expect((await loginStaff(app(), 'klp.temp', 'settled-password')).status).toBe(403)
  })
})

describe('customer ↔ inmate linking', () => {
  it('records a link request as pending and refuses duplicates', async () => {
    const { client: sup } = await loginStaff(app())
    const klpId = await prisonIdByCode('KLP')
    const prison = (await sup.json(`${BASE}/prisons/${klpId}`)) as any
    expect(prison.zones.length).toBeGreaterThan(0)

    const { client: relative } = await loginCustomer(app(), '0856789012')
    const before = (await relative.json(`${BASE}/me`)) as any
    expect(before.inmates).toEqual([])

    // Pick an inmate from the seeded Klong Prem set via another relative's link.
    const { client: other } = await loginCustomer(app(), '0812345678')
    const otherMe = (await other.json(`${BASE}/me`)) as any
    const inmateId = otherMe.inmates[0].inmateId

    const created = await relative.request(`${BASE}/me/inmates`, {
      method: 'POST',
      json: { inmateId, relationship: 'พี่สาว' }
    })
    expect(created.status).toBe(201)
    expect(((await created.json()) as any).inmates[0].verifyStatus).toBe('pending')

    const dup = await relative.request(`${BASE}/me/inmates`, {
      method: 'POST',
      json: { inmateId, relationship: 'พี่สาว' }
    })
    expect(dup.status).toBe(409)
  })
})
