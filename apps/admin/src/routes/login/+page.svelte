<script lang="ts">
  import { goto } from '$app/navigation'
  import { page } from '$app/state'
  import { Alert, Button, Field } from '@pc/ui'
  import { session, toFormError } from '$lib/session.svelte.js'

  let username = $state('')
  let password = $state('')
  let loading = $state(false)
  let message = $state('')
  let fields = $state<Record<string, string[]>>({})

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

<main class="flex min-h-dvh items-center justify-center px-6">
  <div class="w-full max-w-sm">
    <div class="mb-8 text-center">
      <h1 class="text-xl font-semibold text-ink">ระบบหลังบ้านเรือนจำ</h1>
      <p class="text-sm text-muted">สำหรับเจ้าหน้าที่เท่านั้น</p>
    </div>

    {#if message}
      <div class="mb-4"><Alert tone="danger" title={message} /></div>
    {/if}

    <form class="space-y-4" onsubmit={submit}>
      <Field
        label="ชื่อผู้ใช้"
        bind:value={username}
        autocomplete="username"
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

    <p class="mt-6 text-center text-xs text-muted">
      ชื่อผู้ใช้ถูกกำหนดโดยผู้ดูแลระบบ · ลืมรหัสผ่านให้ติดต่อผู้ดูแลระบบเพื่อออกรหัสผ่านชั่วคราว
    </p>
  </div>
</main>
