<script lang="ts">
  import { goto } from '$app/navigation'
  import { Alert, Button, Field } from '@pc/ui'
  import { session, toFormError } from '$lib/session.svelte.js'

  let current = $state('')
  let next = $state('')
  let confirm = $state('')
  let loading = $state(false)
  let message = $state('')
  let fields = $state<Record<string, string[]>>({})

  const mismatch = $derived(confirm.length > 0 && confirm !== next)
  const forced = $derived(session.mustChangePassword)

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    if (mismatch) return
    loading = true
    message = ''
    fields = {}
    try {
      await session.changePassword(current, next)
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
  <h1 class="text-xl font-semibold text-ink">เปลี่ยนรหัสผ่าน</h1>

  {#if forced}
    <div class="mt-4">
      <Alert tone="warning" title="ต้องตั้งรหัสผ่านใหม่ก่อนใช้งาน">
        รหัสผ่านปัจจุบันเป็นรหัสผ่านชั่วคราวที่เจ้าหน้าที่ออกให้
      </Alert>
    </div>
  {/if}

  {#if message}
    <div class="mt-4"><Alert tone="danger" title={message} /></div>
  {/if}

  <form class="mt-6 space-y-4" onsubmit={submit}>
    <Field
      label={forced ? 'รหัสผ่านชั่วคราว' : 'รหัสผ่านปัจจุบัน'}
      bind:value={current}
      type="password"
      autocomplete="current-password"
      errors={fields.current}
      required
    />
    <Field
      label="รหัสผ่านใหม่"
      bind:value={next}
      type="password"
      autocomplete="new-password"
      hint="อย่างน้อย 8 ตัวอักษร"
      errors={fields.next}
      required
    />
    <Field
      label="ยืนยันรหัสผ่านใหม่"
      bind:value={confirm}
      type="password"
      autocomplete="new-password"
      errors={mismatch ? ['รหัสผ่านไม่ตรงกัน'] : []}
      required
    />

    <Button type="submit" full size="lg" {loading} disabled={mismatch}>บันทึกรหัสผ่านใหม่</Button>
  </form>

  <p class="mt-4 text-center text-xs text-muted">
    การเปลี่ยนรหัสผ่านจะออกจากระบบในอุปกรณ์อื่นทั้งหมด
  </p>
</main>
