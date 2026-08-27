import { describe, expect, it, beforeAll } from 'vitest'
import { SignJWT } from 'jose'

/**
 * LINE Login channel, faked end to end. LINE signs ID tokens with HS256 over
 * the channel secret for web logins, so a test can mint a genuine one — the
 * verifier under test is the real one, not a stub.
 */
const CHANNEL_ID = '1234567890'
const CHANNEL_SECRET = 'line-channel-secret-used-only-by-tests'

process.env.LINE_CHANNEL_ID = CHANNEL_ID
process.env.LINE_CHANNEL_SECRET = CHANNEL_SECRET

const { BASE, DEV_PASSWORD, createClient, loginCustomer, loginStaff, setupApp } = await import(
  './helpers.js'
)

const ctx = setupApp()
const app = () => ctx.app

const key = () => new TextEncoder().encode(CHANNEL_SECRET)

async function idToken(
  sub: string,
  opts: { name?: string; audience?: string; expired?: boolean } = {}
) {
  return new SignJWT({ name: opts.name ?? 'สมชาย ใจดี', picture: 'https://profile.line/x.jpg' })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer('https://access.line.me')
    .setAudience(opts.audience ?? CHANNEL_ID)
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime(opts.expired ? '-1m' : '10m')
    .sign(key())
}

/** The feature is off in a fresh database — every test here turns it on first. */
async function enableLineLogin() {
  const { client } = await loginStaff(app())
  const res = await client.request(`${BASE}/admin/settings/features.line_login`, {
    method: 'PUT',
    json: { value: true }
  })
  expect(res.status).toBe(200)
}

beforeAll(enableLineLogin)

describe('LINE account linking', () => {
  it('links a verified LINE identity onto the signed-in account', async () => {
    const { client } = await loginCustomer(app())
    const res = await client.request(`${BASE}/auth/line/link`, {
      method: 'POST',
      json: { idToken: await idToken('U-link-0001') }
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ lineLinked: true, lineDisplayName: 'สมชาย ใจดี' })

    const me = (await client.json(`${BASE}/me`)) as any
    expect(me.lineLinked).toBe(true)
    expect(me.lineDisplayName).toBe('สมชาย ใจดี')
  })

  it('refuses to link a LINE account another relative already holds', async () => {
    const { client } = await loginCustomer(app(), '0823456789')
    const res = await client.request(`${BASE}/auth/line/link`, {
      method: 'POST',
      json: { idToken: await idToken('U-link-0001') }
    })
    expect(res.status).toBe(409)
  })

  it('rejects a token minted for a different channel, and an expired one', async () => {
    const { client } = await loginCustomer(app(), '0834567890')
    for (const token of [
      await idToken('U-other-channel', { audience: '9999999999' }),
      await idToken('U-expired', { expired: true })
    ]) {
      const res = await client.request(`${BASE}/auth/line/link`, {
        method: 'POST',
        json: { idToken: token }
      })
      expect(res.status).toBe(400)
    }
  })

  it('needs a session — the ID token alone links nothing', async () => {
    const anon = createClient(app())
    const res = await anon.request(`${BASE}/auth/line/link`, {
      method: 'POST',
      json: { idToken: await idToken('U-anonymous') }
    })
    expect(res.status).toBe(401)
  })
})

describe('LINE login', () => {
  it('issues the same session shape as a password login', async () => {
    const { client } = await loginCustomer(app(), '0845678901')
    await client.request(`${BASE}/auth/line/link`, {
      method: 'POST',
      json: { idToken: await idToken('U-login-0001') }
    })

    const fresh = createClient(app())
    const res = await fresh.request(`${BASE}/auth/line/login`, {
      method: 'POST',
      json: { idToken: await idToken('U-login-0001') }
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as any
    expect(body).toMatchObject({ expiresIn: 900, mustChangePassword: false })

    // Same rotating-refresh cookie as the password path.
    expect(res.headers.getSetCookie().some((c) => c.startsWith('pc_rt='))).toBe(true)

    fresh.token = body.accessToken
    const me = (await fresh.json(`${BASE}/me`)) as any
    expect(me.username).toBe('0845678901')
  })

  it('answers LINE_NOT_LINKED rather than creating a second account', async () => {
    const anon = createClient(app())
    const res = await anon.request(`${BASE}/auth/line/login`, {
      method: 'POST',
      json: { idToken: await idToken('U-nobody-claims-this') }
    })
    expect(res.status).toBe(404)
    expect((await res.json()) as any).toMatchObject({ error: { code: 'LINE_NOT_LINKED' } })
  })

  it('unlinking leaves the password login working and the LINE one not', async () => {
    const { client } = await loginCustomer(app(), '0856789012')
    await client.request(`${BASE}/auth/line/link`, {
      method: 'POST',
      json: { idToken: await idToken('U-unlink-0001') }
    })

    const unlinked = await client.request(`${BASE}/auth/line/link`, { method: 'DELETE' })
    expect(unlinked.status).toBe(200)
    expect(await unlinked.json()).toMatchObject({ lineLinked: false })

    const anon = createClient(app())
    const res = await anon.request(`${BASE}/auth/line/login`, {
      method: 'POST',
      json: { idToken: await idToken('U-unlink-0001') }
    })
    expect(res.status).toBe(404)

    const again = await loginCustomer(app(), '0856789012', DEV_PASSWORD)
    expect(again.status).toBe(200)
  })
})
