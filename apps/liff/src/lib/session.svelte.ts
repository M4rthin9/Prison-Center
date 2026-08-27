import { createApiClient, ApiClientError } from '@pc/contract/client'
import type { MeResponse } from '@pc/contract'
import { goto } from '$app/navigation'
import { PUBLIC_API_BASE_URL } from '$env/static/public'

/**
 * One client for the whole app. The access token lives inside its closure —
 * never in localStorage, because the LINE in-app webview shares storage across
 * the whole origin and that token is the easiest thing to steal.
 */
export const api = createApiClient({
  baseUrl: PUBLIC_API_BASE_URL || '/api/v1',
  realm: 'customer',
  onAuthExpired: () => session.clear()
})

class Session {
  me = $state<MeResponse | null>(null)
  /** null until the first refresh attempt settles — routes wait on this. */
  ready = $state(false)
  error = $state<string | null>(null)

  readonly signedIn = $derived(this.me !== null)
  readonly mustChangePassword = $derived(this.me?.mustChangePassword ?? false)
  readonly verifiedInmates = $derived(
    this.me?.inmates.filter((i) => i.verifyStatus === 'verified') ?? []
  )
  /** The gate for money, letters and visits. */
  readonly canTransact = $derived(this.verifiedInmates.length > 0)

  /** Restores a session from the httpOnly refresh cookie on boot. */
  async boot() {
    if (this.ready) return
    try {
      if (await api.resume()) await this.load()
    } catch {
      this.me = null
    } finally {
      this.ready = true
    }
  }

  async load() {
    try {
      this.me = await api.me.get()
    } catch (err) {
      // A forced password change is not a failure — it is a state the app must
      // render, so keep the session and let the guard route to the change screen.
      if (err instanceof ApiClientError && err.code === 'MUST_CHANGE_PASSWORD') {
        this.me = { mustChangePassword: true } as MeResponse
        return
      }
      this.me = null
      throw err
    }
  }

  async signIn(username: string, password: string) {
    const res = await api.auth.login({ username, password })
    if (res.mustChangePassword) {
      this.me = { mustChangePassword: true } as MeResponse
      return res
    }
    await this.load()
    return res
  }

  async register(input: { phone: string; password: string; fullName: string }) {
    await api.auth.register(input)
    await this.load()
  }

  /**
   * LINE login. The ID token is proof of a LINE identity, not of an account —
   * an unlinked one comes back as LINE_NOT_LINKED, which the caller turns into
   * "sign in with your phone once, then link".
   */
  async signInWithLine(idToken: string) {
    const res = await api.auth.lineLogin({ idToken })
    if (res.mustChangePassword) {
      this.me = { mustChangePassword: true } as MeResponse
      return res
    }
    await this.load()
    return res
  }

  async linkLine(idToken: string) {
    await api.auth.linkLine({ idToken })
    await this.load()
  }

  async unlinkLine() {
    await api.auth.unlinkLine()
    await this.load()
  }

  async changePassword(current: string, next: string) {
    await api.auth.changePassword({ current, next })
    await this.load()
  }

  async signOut() {
    await api.auth.logout()
    this.clear()
    await goto('/login', { replaceState: true })
  }

  clear() {
    this.me = null
    this.ready = true
  }
}

export const session = new Session()

/** Turns any thrown error into a message plus per-field messages for the form. */
export function toFormError(err: unknown): { message: string; fields: Record<string, string[]> } {
  if (err instanceof ApiClientError) {
    return { message: err.message, fields: err.fields ?? {} }
  }
  return { message: 'เชื่อมต่อระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง', fields: {} }
}
