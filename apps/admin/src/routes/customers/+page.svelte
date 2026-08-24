<script lang="ts">
  import { Alert, Button, Card, formatDateTime, formatPhone } from '@pc/ui'
  import { api, toFormError } from '$lib/session.svelte.js'

  interface CustomerRow {
    id: string
    username: string
    fullName: string
    phone: string
    isBlocked: boolean
    mustChangePassword: boolean
    lockedUntil: number | null
    lastLoginAt: number | null
    linkCount: number
    createdAt: number
  }

  let q = $state('')
  let rows = $state<CustomerRow[]>([])
  let total = $state(0)
  let loading = $state(true)
  let message = $state('')
  let tone = $state<'danger' | 'success'>('success')
  /** The one-time password is shown once, right here, and never again. */
  let issued = $state<{ name: string; password: string } | null>(null)

  async function load() {
    loading = true
    try {
      const res = await api.request<{ items: CustomerRow[]; total: number }>('/admin/customers', {
        query: { q, limit: 50 }
      })
      rows = res.items
      total = res.total
    } catch (err) {
      tone = 'danger'
      message = toFormError(err).message
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void load()
  })

  async function resetPassword(row: CustomerRow) {
    message = ''
    try {
      const res = await api.request<{ oneTimePassword: string }>(
        `/admin/customers/${row.id}/reset-password`,
        { method: 'POST' }
      )
      issued = { name: row.fullName, password: res.oneTimePassword }
      await load()
    } catch (err) {
      tone = 'danger'
      message = toFormError(err).message
    }
  }

  async function unlock(row: CustomerRow) {
    message = ''
    try {
      await api.request(`/admin/customers/${row.id}/unlock`, { method: 'POST' })
      tone = 'success'
      message = `ปลดล็อกบัญชี ${row.fullName} แล้ว`
      await load()
    } catch (err) {
      tone = 'danger'
      message = toFormError(err).message
    }
  }

  const isLocked = (row: CustomerRow) => (row.lockedUntil ?? 0) > Date.now()
</script>

<div class="space-y-5">
  <div class="flex items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold text-ink">บัญชีญาติผู้ต้องขัง</h1>
      <p class="text-muted">{total} บัญชี</p>
    </div>
    <form
      class="flex gap-2"
      onsubmit={(e) => {
        e.preventDefault()
        void load()
      }}
    >
      <input
        bind:value={q}
        placeholder="ค้นหาชื่อหรือเบอร์มือถือ"
        class="h-11 w-72 rounded-xl border border-line bg-white px-3.5"
      />
      <Button type="submit">ค้นหา</Button>
    </form>
  </div>

  {#if issued}
    <Alert tone="warning" title="รหัสผ่านชั่วคราวของ {issued.name}">
      <p class="mt-1 font-mono text-lg tracking-widest text-ink">{issued.password}</p>
      <p class="mt-1">
        แจ้งรหัสนี้ให้เจ้าของบัญชีทันที ระบบไม่เก็บไว้และดูย้อนหลังไม่ได้
        เมื่อเข้าสู่ระบบครั้งแรกจะถูกบังคับให้ตั้งรหัสผ่านใหม่
      </p>
      <button class="mt-2 text-brand-700 underline" type="button" onclick={() => (issued = null)}>
        ปิดข้อความนี้
      </button>
    </Alert>
  {/if}

  {#if message}
    <Alert {tone} title={message} />
  {/if}

  <Card padded={false}>
    <div class="overflow-x-auto">
      <table class="admin-table">
        <thead>
          <tr>
            <th>ชื่อ-นามสกุล</th>
            <th>เบอร์มือถือ</th>
            <th>ผู้ต้องขังที่ผูก</th>
            <th>สถานะ</th>
            <th>เข้าใช้ล่าสุด</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr>
              <td class="font-medium text-ink">{row.fullName}</td>
              <td>{formatPhone(row.phone)}</td>
              <td>{row.linkCount}</td>
              <td>
                {#if row.isBlocked}
                  <span class="rounded-full bg-danger/15 px-2.5 py-1 text-xs">ถูกระงับ</span>
                {:else if isLocked(row)}
                  <span class="rounded-full bg-warn/20 px-2.5 py-1 text-xs">
                    ล็อกถึง {formatDateTime(row.lockedUntil)}
                  </span>
                {:else if row.mustChangePassword}
                  <span class="rounded-full bg-brand-50 px-2.5 py-1 text-xs">รอตั้งรหัสผ่าน</span>
                {:else}
                  <span class="rounded-full bg-ok/15 px-2.5 py-1 text-xs">ปกติ</span>
                {/if}
              </td>
              <td class="text-muted">{formatDateTime(row.lastLoginAt)}</td>
              <td class="text-right whitespace-nowrap">
                {#if isLocked(row)}
                  <Button size="sm" variant="secondary" onclick={() => unlock(row)}>ปลดล็อก</Button>
                {/if}
                <Button size="sm" variant="ghost" onclick={() => resetPassword(row)}>
                  ออกรหัสผ่านชั่วคราว
                </Button>
              </td>
            </tr>
          {:else}
            <tr>
              <td colspan="6" class="py-8 text-center text-muted">
                {loading ? 'กำลังโหลด…' : 'ไม่พบบัญชี'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Card>

  <p class="text-sm text-muted">
    คำขอผูกบัญชีกับผู้ต้องขังรอการตรวจสอบอยู่ที่
    <a class="text-brand-700 underline" href="/customers/verify">หน้าคำขอผูกบัญชี</a>
  </p>
</div>
