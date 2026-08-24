import { createApiClient, ApiClientError } from '@pc/contract/client'
import type { AdminMeResponse } from '@pc/contract'
import { goto } from '$app/navigation'
import { PUBLIC_API_BASE_URL } from '$env/static/public'

export const api = createApiClient({
  baseUrl: PUBLIC_API_BASE_URL || '/api/v1',
  realm: 'admin',
  onAuthExpired: () => session.clear()
})

class Session {
  me = $state<AdminMeResponse | null>(null)
  ready = $state(false)

  readonly signedIn = $derived(this.me !== null)
  readonly mustChangePassword = $derived(this.me?.mustChangePassword ?? false)
  readonly isSuperAdmin = $derived(this.me?.role === 'super_admin')
  /** null == department-wide. Every list screen shows this as its scope. */
  readonly scopeLabel = $derived(this.me?.prisonName ?? 'ทุกเรือนจำ')

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
      this.me = await api.admin.me()
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'MUST_CHANGE_PASSWORD') {
        this.me = { mustChangePassword: true } as AdminMeResponse
        return
      }
      this.me = null
      throw err
    }
  }

  async signIn(username: string, password: string) {
    const res = await api.auth.login({ username, password })
    if (res.mustChangePassword) {
      this.me = { mustChangePassword: true } as AdminMeResponse
      return res
    }
    await this.load()
    return res
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

export function toFormError(err: unknown): { message: string; fields: Record<string, string[]> } {
  if (err instanceof ApiClientError) {
    return { message: err.message, fields: err.fields ?? {} }
  }
  return { message: 'เชื่อมต่อระบบไม่สำเร็จ กรุณาลองใหม่อีกครั้ง', fields: {} }
}

export const ROLE_LABEL: Record<string, string> = {
  super_admin: 'ผู้ดูแลระบบส่วนกลาง',
  prison_admin: 'ผู้ดูแลเรือนจำ',
  zone_staff: 'เจ้าหน้าที่แดน',
  finance: 'การเงิน',
  letter_operator: 'งานจดหมาย'
}
