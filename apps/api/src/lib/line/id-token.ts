import { createRemoteJWKSet, jwtVerify, decodeProtectedHeader } from 'jose'
import { env } from '../../env.js'
import { badRequest } from '../errors.js'

/** The verified subset of a LINE ID token. `sub` is the only identity claim. */
export interface LineIdentity {
  sub: string
  name: string | null
  picture: string | null
  email: string | null
}

export interface VerifyOptions {
  /** Must match the nonce the client passed to `liff.init` / the login URL. */
  nonce?: string | null
}

const ISSUER = 'https://access.line.me'

let jwks: ReturnType<typeof createRemoteJWKSet> | null = null
const remoteKeys = () =>
  (jwks ??= createRemoteJWKSet(new URL(`${env().LINE_API_BASE}/oauth2/v2.1/certs`)))

let secretKey: Uint8Array | null = null
const channelSecret = () => {
  const s = env().LINE_CHANNEL_SECRET
  if (!s) throw badRequest('ยังไม่ได้ตั้งค่า LINE_CHANNEL_SECRET')
  return (secretKey ??= new TextEncoder().encode(s))
}

/**
 * LINE signs ID tokens with **either** algorithm depending on how the channel
 * is configured: HS256 with the channel secret for a web login, ES256 against
 * the published JWKS for LIFF. Which one arrives is not ours to choose, so
 * both are accepted — and nothing else is.
 */
export async function verifyLineIdToken(
  idToken: string,
  opts: VerifyOptions = {}
): Promise<LineIdentity> {
  const e = env()
  if (!e.LINE_CHANNEL_ID) throw badRequest('ยังไม่ได้เปิดใช้งานการเข้าสู่ระบบด้วย LINE')

  let alg: string | undefined
  try {
    alg = decodeProtectedHeader(idToken).alg
  } catch {
    throw badRequest('โทเคน LINE ไม่ถูกต้อง')
  }
  if (alg !== 'HS256' && alg !== 'ES256') throw badRequest('โทเคน LINE ไม่ถูกต้อง')

  let payload: Record<string, unknown>
  try {
    const verified =
      alg === 'HS256'
        ? await jwtVerify(idToken, channelSecret(), {
            issuer: ISSUER,
            audience: e.LINE_CHANNEL_ID,
            algorithms: ['HS256']
          })
        : await jwtVerify(idToken, remoteKeys(), {
            issuer: ISSUER,
            audience: e.LINE_CHANNEL_ID,
            algorithms: ['ES256']
          })
    payload = verified.payload as Record<string, unknown>
  } catch {
    throw badRequest('โทเคน LINE ไม่ถูกต้องหรือหมดอายุ')
  }

  // A replayed token from another session is only detectable through the
  // nonce, so a caller that sent one must get it back unchanged.
  if (opts.nonce && payload.nonce !== opts.nonce) throw badRequest('nonce ของ LINE ไม่ตรงกัน')

  const sub = typeof payload.sub === 'string' ? payload.sub : ''
  if (!sub) throw badRequest('โทเคน LINE ไม่มีรหัสผู้ใช้')

  return {
    sub,
    name: typeof payload.name === 'string' ? payload.name : null,
    picture: typeof payload.picture === 'string' ? payload.picture : null,
    email: typeof payload.email === 'string' ? payload.email : null
  }
}
