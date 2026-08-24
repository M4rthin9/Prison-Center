import { describe, expect, it } from 'vitest'
import { BASE, DEV_PASSWORD, createClient, loginCustomer, loginStaff, setupApp } from './helpers.js'

// setupApp builds the app inside beforeAll; read it lazily.
const ctx = setupApp()
const app = () => ctx.app

describe('customer password auth', () => {
  it('logs a seeded relative in and returns the shared session shape', async () => {
    const { status, body } = await loginCustomer(app())
    expect(status).toBe(200)
    expect(body).toMatchObject({ expiresIn: 900, mustChangePassword: false })
    expect(body.accessToken).toBeTypeOf('string')
  })

  it('accepts +66 and dashed phone forms as the same username', async () => {
    for (const form of ['+66812345678', '081-234-5678', '081 234 5678']) {
      const { status } = await loginCustomer(app(), form)
      expect(status, form).toBe(200)
    }
  })

  it('rejects a wrong password without revealing whether the account exists', async () => {
    const wrong = await loginCustomer(app(), '0812345678', 'not-the-password')
    const missing = await loginCustomer(app(), '0899999999', 'not-the-password')
    expect(wrong.status).toBe(401)
    expect(missing.status).toBe(401)
    expect((wrong.body as any).error.message).toBe((missing.body as any).error.message)
  })

  it('sets an httpOnly refresh cookie scoped to the auth path', async () => {
    const c = createClient(app())
    const res = await c.request(`${BASE}/auth/login`, {
      method: 'POST',
      json: { username: '0823456789', password: DEV_PASSWORD }
    })
    const cookie = res.headers.getSetCookie().find((h) => h.startsWith('pc_rt='))!
    expect(cookie).toContain('HttpOnly')
    expect(cookie).toContain('Path=/api/v1/auth')
    expect(cookie).toContain('SameSite=Lax')
  })

  it('never accepts a customer token on the admin realm', async () => {
    const { client: c } = await loginCustomer(app())
    const res = await c.request(`${BASE}/admin/me`)
    expect(res.status).toBe(401)
  })
})

describe('registration', () => {
  it('creates a browse-only account and normalizes the phone to the username', async () => {
    const c = createClient(app())
    const res = await c.request(`${BASE}/auth/register`, {
      method: 'POST',
      json: { phone: '+66900000001', password: 'a-good-password', fullName: 'ทดสอบ ระบบ' }
    })
    expect(res.status).toBe(201)
    const session = (await res.json()) as { accessToken: string }
    c.token = session.accessToken

    const me = (await c.json(`${BASE}/me`)) as any
    expect(me.username).toBe('0900000001')
    // Nothing is linked, so nothing sensitive is reachable yet.
    expect(me.inmates).toEqual([])
  })

  it('refuses a duplicate phone number', async () => {
    const c = createClient(app())
    const res = await c.request(`${BASE}/auth/register`, {
      method: 'POST',
      json: { phone: '0812345678', password: 'a-good-password', fullName: 'ซ้ำ ซ้อน' }
    })
    expect(res.status).toBe(409)
  })

  it('rejects a non-mobile number and a short password', async () => {
    const c = createClient(app())
    const bad = await c.request(`${BASE}/auth/register`, {
      method: 'POST',
      json: { phone: '021234567', password: 'short', fullName: 'ผิด รูปแบบ' }
    })
    expect(bad.status).toBe(422)
    const body = (await bad.json()) as any
    expect(Object.keys(body.error.fields)).toEqual(expect.arrayContaining(['phone', 'password']))
  })
})

describe('rotating refresh tokens', () => {
  it('rotates the cookie on every refresh', async () => {
    const { client: c } = await loginCustomer(app(), '0834567890')
    const first = c.cookies.get('pc_rt')

    const res = await c.request(`${BASE}/auth/refresh`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(c.cookies.get('pc_rt')).not.toBe(first)
  })

  it('treats replay of a used refresh token as a leak and kills every session', async () => {
    const { client: c } = await loginCustomer(app(), '0845678901')
    const stolen = c.cookies.get('pc_rt')!

    await c.request(`${BASE}/auth/refresh`, { method: 'POST' })
    const live = c.cookies.get('pc_rt')!

    // Replay the old cookie.
    const replay = createClient(app())
    replay.cookies.set('pc_rt', stolen)
    expect((await replay.request(`${BASE}/auth/refresh`, { method: 'POST' })).status).toBe(401)

    // The legitimate rotated token is revoked too — the user must log in again.
    const legit = createClient(app())
    legit.cookies.set('pc_rt', live)
    expect((await legit.request(`${BASE}/auth/refresh`, { method: 'POST' })).status).toBe(401)
  })

  it('clears the cookie on logout and refuses to refresh afterwards', async () => {
    const { client: c } = await loginCustomer(app(), '0856789012')
    expect((await c.request(`${BASE}/auth/logout`, { method: 'POST' })).status).toBe(204)
    const after = createClient(app())
    expect((await after.request(`${BASE}/auth/refresh`, { method: 'POST' })).status).toBe(401)
  })
})

describe('lockout', () => {
  it('locks an account after five failures and keeps it locked for the right password', async () => {
    const c = createClient(app())
    const username = '0823456789'
    let last = 0
    for (let i = 0; i < 5; i++) {
      const res = await c.request(`${BASE}/auth/login`, {
        method: 'POST',
        json: { username, password: `wrong-${i}` }
      })
      last = res.status
    }
    expect(last).toBe(423)

    const correct = await c.request(`${BASE}/auth/login`, {
      method: 'POST',
      json: { username, password: DEV_PASSWORD }
    })
    expect(correct.status).toBe(423)
    expect(correct.headers.get('retry-after')).toBeTruthy()
  })

  it('lets an admin unlock the account', async () => {
    const { client: admin } = await loginStaff(app())
    const list = (await admin.json(`${BASE}/admin/customers?q=0823456789`)) as any
    const target = list.items[0]
    expect(target.lockedUntil).toBeGreaterThan(Date.now())

    const unlock = await admin.request(`${BASE}/admin/customers/${target.id}/unlock`, {
      method: 'POST'
    })
    expect(unlock.status).toBe(200)

    const after = await loginCustomer(app(), '0823456789')
    expect(after.status).toBe(200)
  })
})

describe('staff-assisted password reset', () => {
  it('issues a one-time password that forces a change before anything else works', async () => {
    const { client: admin } = await loginStaff(app())
    const list = (await admin.json(`${BASE}/admin/customers?q=0834567890`)) as any
    const target = list.items[0]

    const reset = (await admin.json(`${BASE}/admin/customers/${target.id}/reset-password`, {
      method: 'POST'
    })) as any
    expect(reset.mustChangePassword).toBe(true)
    expect(reset.oneTimePassword).toMatch(/^[A-Z2-9]{10}$/)

    // The old password no longer works.
    expect((await loginCustomer(app(), '0834567890')).status).toBe(401)

    const { client: c, body } = await loginCustomer(app(), '0834567890', reset.oneTimePassword)
    expect(body.mustChangePassword).toBe(true)

    // Everything except the change itself is blocked.
    const blocked = await c.request(`${BASE}/me`)
    expect(blocked.status).toBe(403)
    expect(((await blocked.json()) as any).error.code).toBe('MUST_CHANGE_PASSWORD')

    const changed = await c.request(`${BASE}/auth/change-password`, {
      method: 'POST',
      json: { current: reset.oneTimePassword, next: 'brand-new-password' }
    })
    expect(changed.status).toBe(200)
    c.token = ((await changed.json()) as any).accessToken

    const me = await c.request(`${BASE}/me`)
    expect(me.status).toBe(200)
  })

  it('rejects a change with the wrong current password', async () => {
    const { client: c } = await loginCustomer(app())
    const res = await c.request(`${BASE}/auth/change-password`, {
      method: 'POST',
      json: { current: 'definitely-wrong', next: 'another-new-password' }
    })
    expect(res.status).toBe(400)
  })
})
