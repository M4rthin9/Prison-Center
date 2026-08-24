<script lang="ts">
  import { goto } from '$app/navigation'
  import { Alert, Button, Field } from '@pc/ui'
  import { session, toFormError } from '$lib/session.svelte.js'

  let fullName = $state('')
  let phone = $state('')
  let password = $state('')
  let confirm = $state('')
  let loading = $state(false)
  let message = $state('')
  let fields = $state<Record<string, string[]>>({})

  const mismatch = $derived(confirm.length > 0 && confirm !== password)

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (mismatch) return
    loading = true
    message = ''
    fields = {}
    try {
      await session.register({ fullName, phone, password })
      await goto('/', { replaceState: true })
    } catch (err) {
      const e = toFormError(err)
      message = e.message
      fields = e.fields
    } finally {
      loading = false
    }
  }
</script>

<main class="min-h-dvh px-6 py-10">
  <h1 class="text-xl font-semibold text-ink">สมัครสมาชิก</h1>
  <p class="mt-1 mb-6 text-sm text-muted">
    เบอร์มือถือของคุณคือชื่อผู้ใช้ หลังสมัครแล้วต้องให้เจ้าหน้าที่ยืนยันความสัมพันธ์กับผู้ต้องขัง
    จึงจะสั่งซื้อ ฝากเงิน ส่งจดหมาย หรือจองเยี่ยมได้
  </p>

  {#if message}
    <div class="mb-4"><Alert tone="danger" title={message} /></div>
  {/if}

  <form class="space-y-4" onsubmit={submit}>
    <Field
      label="ชื่อ-นามสกุล"
      bind:value={fullName}
      autocomplete="name"
      errors={fields.fullName}
      required
    />
    <Field
      label="เบอร์มือถือ"
      bind:value={phone}
      type="tel"
      inputmode="tel"
      autocomplete="tel"
      placeholder="08X-XXX-XXXX"
      hint="ใช้เบอร์นี้เป็นชื่อผู้ใช้สำหรับเข้าสู่ระบบ"
      errors={fields.phone}
      required
    />
    <Field
      label="รหัสผ่าน"
      bind:value={password}
      type="password"
      autocomplete="new-password"
      hint="อย่างน้อย 8 ตัวอักษร"
      errors={fields.password}
      required
    />
    <Field
      label="ยืนยันรหัสผ่าน"
      bind:value={confirm}
      type="password"
      autocomplete="new-password"
      errors={mismatch ? ['รหัสผ่านไม่ตรงกัน'] : []}
      required
    />

    <Button type="submit" full size="lg" {loading} disabled={mismatch}>สมัครสมาชิก</Button>
  </form>

  <p class="mt-6 text-center text-sm text-muted">
    มีบัญชีอยู่แล้ว? <a class="font-medium text-brand-700" href="/login">เข้าสู่ระบบ</a>
  </p>
</main>
