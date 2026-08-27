import { api } from './session.svelte.js'

/**
 * The LIFF wrapper (Phase 7).
 *
 * The whole point of the password-first decision is visible here: this module
 * is *optional*. `line.liffId` comes from public settings, and until a real id
 * is configured nothing below ever runs — the app stays the ordinary mobile
 * web SPA it has been since Phase 1. No LIFF id, no SDK download, no LINE
 * dependency in the boot path.
 */

/** The slice of the LIFF SDK this app actually uses. */
interface LiffSdk {
  init(config: { liffId: string; withLoginOnExternalBrowser?: boolean }): Promise<void>
  isLoggedIn(): boolean
  isInClient(): boolean
  login(config?: { redirectUri?: string }): void
  logout(): void
  getIDToken(): string | null
  closeWindow(): void
}

declare global {
  interface Window {
    liff?: LiffSdk
  }
}

const SDK_URL = 'https://static.line-scdn.net/liff/edge/2/sdk.js'

class Liff {
  /** null until public settings have been read. */
  liffId = $state<string | null>(null)
  ready = $state(false)
  /** True inside the LINE in-app browser; false in Safari/Chrome. */
  inClient = $state(false)
  error = $state<string | null>(null)

  /** Set once `init()` has resolved — the LINE buttons key off this. */
  #sdkPresent = $state(false)
  readonly available = $derived(this.ready && this.#sdkPresent)

  #sdk: LiffSdk | null = null
  #booting: Promise<boolean> | null = null

  /**
   * Loads and initializes the SDK once. Returns false — never throws — when
   * LINE is not configured or the network is blocked: a failed LIFF boot must
   * degrade to "the LINE button is unavailable", not to a broken login screen.
   */
  boot(liffId: string | null): Promise<boolean> {
    this.liffId = liffId
    if (!liffId) {
      this.ready = true
      return Promise.resolve(false)
    }
    return (this.#booting ??= this.#init(liffId))
  }

  async #init(liffId: string): Promise<boolean> {
    try {
      await loadScript(SDK_URL)
      const sdk = window.liff
      if (!sdk) throw new Error('LIFF SDK did not register')
      // Outside the LINE app the user is sent through the LINE Login web flow
      // and comes back to this same URL.
      await sdk.init({ liffId, withLoginOnExternalBrowser: true })
      this.#sdk = sdk
      this.inClient = sdk.isInClient()
      this.#sdkPresent = true
      return true
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err)
      console.warn('[liff] unavailable —', this.error)
      return false
    } finally {
      this.ready = true
    }
  }

  /**
   * Returns a verified-by-LINE ID token, sending the user through the LINE
   * login redirect first if needed. `null` means the caller should stay on the
   * password form.
   */
  async idToken(): Promise<string | null> {
    const sdk = this.#sdk
    if (!sdk) return null
    if (!sdk.isLoggedIn()) {
      // This navigates away; the page re-enters this method after the redirect.
      sdk.login({ redirectUri: window.location.href })
      return null
    }
    return sdk.getIDToken()
  }

  /** Signing out of the app must not leave a LINE session that logs straight back in. */
  logout() {
    try {
      if (this.#sdk?.isLoggedIn()) this.#sdk.logout()
    } catch {
      /* nothing to undo */
    }
  }
}

export const liff = new Liff()

/** Reads the LIFF id from public settings and boots the SDK if one is set. */
export async function bootLiff(): Promise<boolean> {
  try {
    const settings = await api.settings.public()
    return await liff.boot(settings.line.liffId)
  } catch {
    liff.ready = true
    return false
  }
}

let pending: Promise<void> | null = null

function loadScript(src: string): Promise<void> {
  if (window.liff) return Promise.resolve()
  return (pending ??= new Promise<void>((resolve, reject) => {
    const el = document.createElement('script')
    el.src = src
    el.async = true
    el.onload = () => resolve()
    el.onerror = () => reject(new Error(`ไม่สามารถโหลด LIFF SDK จาก ${src}`))
    document.head.appendChild(el)
  }))
}
