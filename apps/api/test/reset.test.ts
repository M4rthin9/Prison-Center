import { describe, expect, it, beforeAll } from 'vitest'

// The console adapter writes the code to the outbox instead of sending it, and
// OTP_ECHO hands it back in the response — the only way a test can read it.
process.env.OTP_ADAPTER = 'console'
process.env.OTP_ECHO = '1'

const { BASE, createClient, loginCustomer, loginStaff, setupApp } = await import('./helpers.js')

const ctx = setupApp()
const app = () => ctx.app

beforeAll(async () => {
  const { client } = await loginStaff(app())
  const res = await client.request(`${BASE}/admin/settings/features.self_service_reset`, {
    method: 'PUT',
    json: { value: true }
  })
  expect(res.status).toBe(200)
})

async function request(phone: string) {
  const client = createClient(app())
  const res = await client.request(`${BASE}/auth/password-reset/request`, {
    method: 'POST',
    json: { phone }
  })
  return { client, status: res.status, body: (await res.json()) as any }
}

describe('self-service password reset', () => {
  it('sends a code and lets the relative choose a new password with it', async () => {
    const { client, status, body } = await request('0812345678')
    expect(status).toBe(200)
    expect(body.reference).toBeTypeOf('string')
    expect(body.code).toMatch(/^\d{6}$/)

    const done = await client.request(`${BASE}/auth/password-reset/verify`, {
      method: 'POST',
      json: { reference: body.reference, code: body.code, password: 'a-brand-new-password' }
    })
    expect(done.status).toBe(204)

    const after = await loginCustomer(app(), '0812345678', 'a-brand-new-password')
    expect(after.status).toBe(200)
    // The old password stops working the moment the new one is set.
    const old = await loginCustomer(app(), '0812345678', 'password123')
    expect(old.status).toBe(401)
  })

  it('revokes every session the account was holding', async () => {
    const { client: live } = await loginCustomer(app(), '0823456789')
    expect((await live.request(`${BASE}/me`)).status).toBe(200)

    const { client, body } = await request('0823456789')
    await client.request(`${BASE}/auth/password-reset/verify`, {
      method: 'POST',
      json: { reference: body.reference, code: body.code, password: 'another-new-password' }
    })

    // The access token outlives the reset by design (15 min), but the refresh
    // cookie behind it is dead, so the session cannot be renewed.
    const refreshed = await live.request(`${BASE}/auth/refresh`, { method: 'POST' })
    expect(refreshed.status).toBe(401)
  })

  it('rejects a wrong code and will not let the same code be spent twice', async () => {
    const { client, body } = await request('0834567890')
    const wrong = String((Number(body.code) + 1) % 1_000_000).padStart(6, '0')

    const bad = await client.request(`${BASE}/auth/password-reset/verify`, {
      method: 'POST',
      json: { reference: body.reference, code: wrong, password: 'does-not-matter-here' }
    })
    expect(bad.status).toBe(400)

    const good = await client.request(`${BASE}/auth/password-reset/verify`, {
      method: 'POST',
      json: { reference: body.reference, code: body.code, password: 'first-use-wins-here' }
    })
    expect(good.status).toBe(204)

    const replay = await client.request(`${BASE}/auth/password-reset/verify`, {
      method: 'POST',
      json: { reference: body.reference, code: body.code, password: 'second-use-must-fail' }
    })
    expect(replay.status).toBe(400)
  })

  it('answers identically for a number nobody has registered', async () => {
    const known = await request('0845678901')
    const unknown = await request('0899999999')

    expect(unknown.status).toBe(known.status)
    expect(Object.keys(unknown.body).sort()).toEqual(Object.keys(known.body).sort())
    expect(unknown.body.channel).toBe(known.body.channel)

    // …and verifying it still fails, because there is no account to reset.
    const res = await unknown.client.request(`${BASE}/auth/password-reset/verify`, {
      method: 'POST',
      json: {
        reference: unknown.body.reference,
        code: unknown.body.code,
        password: 'no-account-behind-this'
      }
    })
    expect(res.status).toBe(400)
  })

  it('throttles repeated requests for the same number', async () => {
    // Each request comes from a different IP, so what bites here is the
    // per-number budget — the one that stops an SMS flood at one phone.
    const phone = '0856789012'
    const codes = [await request(phone), await request(phone), await request(phone)]
    expect(codes.every((r) => r.status === 200)).toBe(true)

    const blocked = await request(phone)
    expect(blocked.status).toBe(429)
  })
})
