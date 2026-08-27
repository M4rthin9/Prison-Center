<script lang="ts">
  import { goto } from '$app/navigation'
  import { page } from '$app/state'
  import { Alert, Button, Field } from '@pc/ui'
  import { api, session, toFormError } from '$lib/session.svelte.js'
  import { bootLiff, liff } from '$lib/liff.svelte.js'
  import { ApiClientError } from '@pc/contract/client'

  let username = $state('')
  let password = $state('')
  let loading = $state(false)
  let lineLoading = $state(false)
  let message = $state('')
  let fields = $state<Record<string, string[]>>({})
  let lineEnabled = $state(false)
  let resetEnabled = $state(false)

  // Public settings decide whether LINE exists at all; the SDK is only fetched
  // when a LIFF id is configured, so this is a no-op on a plain deployment.
  $effect(() => {
    api.settings
      .public()
      .then((s) => {
        lineEnabled = s.features.lineLogin
        resetEnabled = s.features.selfServiceReset
        if (s.features.lineLogin) void bootLiff()
      })
      .catch(() => {})
  })

  async function signInWithLine() {
    lineLoading = true
    message = ''
    try {
      const idToken = await liff.idToken()
      // null means the SDK just navigated to the LINE consent screen; the page
      // will come back here and run this again.
      if (!idToken) return
      const res = await session.signInWithLine(idToken)
      const next = page.url.searchParams.get('next')
      await goto(res.mustChangePassword ? '/change-password' : (next ?? '/'), { replaceState: true })
    } catch (err) {
      message =
        err instanceof ApiClientError && err.code === 'LINE_NOT_LINKED'
          ? 'บัญชี LINE นี้ยังไม่ได้เชื่อมกับบัญชีในระบบ กรุณาเข้าสู่ระบบด้วยเบอร์มือถือ แล้วเชื่อมบัญชีในหน้า “บัญชีของฉัน”'
          : toFormError(err).message
    } finally {
      lineLoading = false
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    loading = true
    message = ''
    fields = {}
    try {
      const res = await session.signIn(username, password)
      const next = page.url.searchParams.get('next')
      await goto(res.mustChangePassword ? '/change-password' : (next ?? '/'), {
        replaceState: true
      })
    } catch (err) {
      const e = toFormError(err)
      message = e.message
      fields = e.fields
    } finally {
      loading = false
    }
  }
</script>

<main class="flex min-h-dvh flex-col justify-center px-6 py-10">
  <div class="mb-8 text-center">
    <div
      class="mx-auto mb-4 flex size-14 items-center justify-center rounded-2xl bg-brand-700 text-2xl text-white"
      aria-hidden="true"
    >
      ⚖
    </div>
    <h1 class="text-xl font-semibold text-ink">ศูนย์บริการญาติผู้ต้องขัง</h1>
    <p class="text-sm text-muted">เข้าสู่ระบบด้วยเบอร์มือถือที่ลงทะเบียนไว้</p>
  </div>

  {#if message}
    <div class="mb-4"><Alert tone="danger" title={message} /></div>
  {/if}

  <form class="space-y-4" onsubmit={submit}>
    <Field
      label="เบอร์มือถือ"
      bind:value={username}
      type="tel"
      inputmode="tel"
      autocomplete="username"
      placeholder="08X-XXX-XXXX"
      errors={fields.username}
      required
    />
    <Field
      label="รหัสผ่าน"
      bind:value={password}
      type="password"
      autocomplete="current-password"
      errors={fields.password}
      required
    />

    <Button type="submit" full size="lg" {loading}>เข้าสู่ระบบ</Button>
  </form>

  <button
    type="button"
    disabled={!lineEnabled || !liff.available || lineLoading}
    onclick={signInWithLine}
    class="mt-3 flex h-13 w-full items-center justify-center gap-2 rounded-xl border border-line
           font-medium disabled:bg-white disabled:text-muted
           {lineEnabled && liff.available ? 'bg-[#06C755] text-white' : ''}"
    title={lineEnabled && liff.available ? 'เข้าสู่ระบบด้วย LINE' : 'ยังไม่เปิดให้บริการ'}
  >
    <span aria-hidden="true">💬</span>
    {lineLoading ? 'กำลังเชื่อมต่อ LINE…' : 'เข้าสู่ระบบด้วย LINE'}
  </button>

  <p class="mt-6 text-center text-sm text-muted">
    ยังไม่มีบัญชี? <a class="font-medium text-brand-700" href="/register">สมัครสมาชิก</a>
  </p>
  {#if resetEnabled}
    <p class="mt-2 text-center text-sm">
      <a class="text-brand-700" href="/forgot-password">ลืมรหัสผ่าน?</a>
    </p>
  {:else}
    <p class="mt-2 text-center text-xs text-muted">
      ลืมรหัสผ่าน? ติดต่อเจ้าหน้าที่เรือนจำเพื่อขอรหัสผ่านชั่วคราว
    </p>
  {/if}
</main>
