<script lang="ts">
  import { goto } from '$app/navigation'
  import { Alert, Button, Field } from '@pc/ui'
  import { api, toFormError } from '$lib/session.svelte.js'
  import type { PasswordResetChallenge } from '@pc/contract'

  let phone = $state('')
  let code = $state('')
  let password = $state('')
  let confirm = $state('')
  let loading = $state(false)
  let message = $state('')
  let tone = $state<'danger' | 'success'>('danger')
  let fields = $state<Record<string, string[]>>({})
  /** null = step 1 (ask for the code); set = step 2 (type it in). */
  let challenge = $state<PasswordResetChallenge | null>(null)

  const CHANNEL_LABEL = {
    sms: 'ส่งรหัสยืนยันทาง SMS แล้ว',
    line: 'ส่งรหัสยืนยันทาง LINE แล้ว',
    console: 'ออกรหัสยืนยันแล้ว (โหมดทดสอบ)'
  } as const

  async function request(event: SubmitEvent) {
    event.preventDefault()
    loading = true
    message = ''
    fields = {}
    try {
      challenge = await api.auth.requestPasswordReset({ phone })
      tone = 'success'
      // The wording is deliberately non-committal: the API answers the same
      // way whether or not the number has an account, and so does this screen.
      message = `${CHANNEL_LABEL[challenge.channel]} หากเบอร์นี้มีบัญชีอยู่ในระบบ`
    } catch (err) {
      const e = toFormError(err)
      tone = 'danger'
      message = e.message
      fields = e.fields
    } finally {
      loading = false
    }
  }

  async function verify(event: SubmitEvent) {
    event.preventDefault()
    if (password !== confirm) {
      tone = 'danger'
      message = 'รหัสผ่านทั้งสองช่องไม่ตรงกัน'
      return
    }
    loading = true
    message = ''
    fields = {}
    try {
      await api.auth.verifyPasswordReset({ reference: challenge!.reference, code, password })
      await goto('/login?reset=1', { replaceState: true })
    } catch (err) {
      const e = toFormError(err)
      tone = 'danger'
      message = e.message
      fields = e.fields
    } finally {
      loading = false
    }
  }
</script>

<main class="flex min-h-dvh flex-col justify-center px-6 py-10">
  <div class="mb-8 text-center">
    <h1 class="text-xl font-semibold text-ink">ตั้งรหัสผ่านใหม่</h1>
    <p class="text-sm text-muted">
      {challenge ? 'กรอกรหัสยืนยัน 6 หลักที่ได้รับ' : 'กรอกเบอร์มือถือที่ลงทะเบียนไว้'}
    </p>
  </div>

  {#if message}
    <div class="mb-4"><Alert {tone} title={message} /></div>
  {/if}

  {#if !challenge}
    <form class="space-y-4" onsubmit={request}>
      <Field
        label="เบอร์มือถือ"
        bind:value={phone}
        type="tel"
        inputmode="tel"
        autocomplete="username"
        placeholder="08X-XXX-XXXX"
        errors={fields.phone}
        required
      />
      <Button type="submit" full size="lg" {loading}>ขอรหัสยืนยัน</Button>
    </form>
  {:else}
    <form class="space-y-4" onsubmit={verify}>
      <p class="rounded-xl bg-brand-50 px-3.5 py-2.5 text-sm text-ink">
        รหัสอ้างอิง <span class="font-mono font-semibold">{challenge.reference}</span>
        {#if challenge.code}
          · รหัสทดสอบ <span class="font-mono font-semibold">{challenge.code}</span>
        {/if}
      </p>
      <Field
        label="รหัสยืนยัน 6 หลัก"
        bind:value={code}
        inputmode="numeric"
        autocomplete="one-time-code"
        errors={fields.code}
        required
      />
      <Field
        label="รหัสผ่านใหม่"
        bind:value={password}
        type="password"
        autocomplete="new-password"
        errors={fields.password}
        required
      />
      <Field
        label="ยืนยันรหัสผ่านใหม่"
        bind:value={confirm}
        type="password"
        autocomplete="new-password"
        required
      />
      <Button type="submit" full size="lg" {loading}>ตั้งรหัสผ่านใหม่</Button>
      <button
        type="button"
        class="w-full text-center text-sm text-muted"
        onclick={() => {
          challenge = null
          message = ''
        }}
      >
        ขอรหัสใหม่อีกครั้ง
      </button>
    </form>
  {/if}

  <p class="mt-6 text-center text-sm">
    <a class="text-brand-700" href="/login">กลับไปหน้าเข้าสู่ระบบ</a>
  </p>
</main>
