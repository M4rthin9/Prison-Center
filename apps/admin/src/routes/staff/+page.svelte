<script lang="ts">
  import { Alert, Button, Card, Field, formatDateTime } from '@pc/ui'
  import { ROLE_LABEL, api, toFormError } from '$lib/session.svelte.js'
  import type { PrisonSummary, StaffRole } from '@pc/contract'

  interface StaffRow {
    id: string
    username: string
    fullName: string
    email: string | null
    role: StaffRole
    prisonId: string | null
    prisonName: string | null
    isActive: boolean
    mustChangePassword: boolean
    lockedUntil: number | null
    lastLoginAt: number | null
  }

  let rows = $state<StaffRow[]>([])
  let prisons = $state<PrisonSummary[]>([])
  let loading = $state(true)
  let message = $state('')
  let tone = $state<'danger' | 'success'>('success')
  let issued = $state<{ name: string; username: string; password: string } | null>(null)

  // create form
  let username = $state('')
  let fullName = $state('')
  let email = $state('')
  let role = $state<StaffRole>('prison_admin')
  let prisonId = $state('')
  let creating = $state(false)
  let fields = $state<Record<string, string[]>>({})

  const needsPrison = $derived(role !== 'super_admin')

  async function load() {
    loading = true
    try {
      const [staffRes, prisonRes] = await Promise.all([
        api.request<{ items: StaffRow[] }>('/admin/staff'),
        api.prisons.list()
      ])
      rows = staffRes.items
      prisons = prisonRes.items
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

  async function create(event: SubmitEvent) {
    event.preventDefault()
    creating = true
    message = ''
    fields = {}
    try {
      const res = await api.request<{ oneTimePassword: string }>('/admin/staff', {
        method: 'POST',
        body: {
          username,
          fullName,
          email: email || undefined,
          role,
          prisonId: needsPrison ? prisonId : null
        }
      })
      issued = { name: fullName, username, password: res.oneTimePassword }
      username = ''
      fullName = ''
      email = ''
      prisonId = ''
      await load()
    } catch (err) {
      const e = toFormError(err)
      tone = 'danger'
      message = e.message
      fields = e.fields
    } finally {
      creating = false
    }
  }

  async function toggleActive(row: StaffRow) {
    message = ''
    try {
      await api.request(`/admin/staff/${row.id}`, {
        method: 'PATCH',
        body: { isActive: !row.isActive }
      })
      tone = 'success'
      message = row.isActive ? `ปิดใช้งาน ${row.fullName} แล้ว` : `เปิดใช้งาน ${row.fullName} แล้ว`
      await load()
    } catch (err) {
      tone = 'danger'
      message = toFormError(err).message
    }
  }

  async function resetPassword(row: StaffRow) {
    message = ''
    try {
      const res = await api.request<{ oneTimePassword: string }>(
        `/admin/staff/${row.id}/reset-password`,
        { method: 'POST' }
      )
      issued = { name: row.fullName, username: row.username, password: res.oneTimePassword }
      await load()
    } catch (err) {
      tone = 'danger'
      message = toFormError(err).message
    }
  }
</script>

<div class="space-y-5">
  <div>
    <h1 class="text-2xl font-semibold text-ink">บัญชีเจ้าหน้าที่</h1>
    <p class="text-muted">
      ชื่อผู้ใช้ถูกกำหนดโดยผู้ดูแลระบบ และทุกบัญชีถูกบังคับเปลี่ยนรหัสผ่านเมื่อเข้าใช้ครั้งแรก
    </p>
  </div>

  {#if issued}
    <Alert tone="warning" title="รหัสผ่านชั่วคราวของ {issued.name} ({issued.username})">
      <p class="mt-1 font-mono text-lg tracking-widest text-ink">{issued.password}</p>
      <p class="mt-1">ระบบไม่เก็บรหัสนี้ไว้ ดูย้อนหลังไม่ได้</p>
      <button class="mt-2 text-brand-700 underline" type="button" onclick={() => (issued = null)}>
        ปิดข้อความนี้
      </button>
    </Alert>
  {/if}

  {#if message}
    <Alert {tone} title={message} />
  {/if}

  <div class="grid gap-5 xl:grid-cols-[1fr_22rem]">
    <Card padded={false}>
      <div class="overflow-x-auto">
        <table class="admin-table">
          <thead>
            <tr>
              <th>ชื่อ-นามสกุล</th>
              <th>ชื่อผู้ใช้</th>
              <th>บทบาท</th>
              <th>เรือนจำ</th>
              <th>เข้าใช้ล่าสุด</th>
              <th>สถานะ</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each rows as row (row.id)}
              <tr>
                <td class="font-medium text-ink">{row.fullName}</td>
                <td class="font-mono text-sm">{row.username}</td>
                <td>{ROLE_LABEL[row.role]}</td>
                <td>{row.prisonName ?? 'ส่วนกลาง'}</td>
                <td class="text-muted">{formatDateTime(row.lastLoginAt)}</td>
                <td>
                  {#if !row.isActive}
                    <span class="rounded-full bg-danger/15 px-2.5 py-1 text-xs">ปิดใช้งาน</span>
                  {:else if row.mustChangePassword}
                    <span class="rounded-full bg-brand-50 px-2.5 py-1 text-xs">รอตั้งรหัสผ่าน</span>
                  {:else}
                    <span class="rounded-full bg-ok/15 px-2.5 py-1 text-xs">ปกติ</span>
                  {/if}
                </td>
                <td class="text-right whitespace-nowrap">
                  <Button size="sm" variant="ghost" onclick={() => resetPassword(row)}>
                    รีเซ็ตรหัสผ่าน
                  </Button>
                  <Button size="sm" variant="secondary" onclick={() => toggleActive(row)}>
                    {row.isActive ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}
                  </Button>
                </td>
              </tr>
            {:else}
              <tr>
                <td colspan="7" class="py-8 text-center text-muted">
                  {loading ? 'กำลังโหลด…' : 'ไม่มีบัญชี'}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </Card>

    <Card title="สร้างบัญชีเจ้าหน้าที่">
      <form class="space-y-4" onsubmit={create}>
        <Field
          label="ชื่อผู้ใช้"
          bind:value={username}
          hint="a-z 0-9 . _ - เท่านั้น เช่น klp.finance"
          errors={fields.username}
          required
        />
        <Field label="ชื่อ-นามสกุล" bind:value={fullName} errors={fields.fullName} required />
        <Field label="อีเมล (ถ้ามี)" bind:value={email} type="email" errors={fields.email} />

        <div class="space-y-1.5">
          <label class="block text-sm font-medium text-ink" for="role">บทบาท</label>
          <select
            id="role"
            bind:value={role}
            class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5"
          >
            {#each Object.entries(ROLE_LABEL) as [value, label] (value)}
              <option {value}>{label}</option>
            {/each}
          </select>
        </div>

        {#if needsPrison}
          <div class="space-y-1.5">
            <label class="block text-sm font-medium text-ink" for="prison">เรือนจำ</label>
            <select
              id="prison"
              bind:value={prisonId}
              class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5"
              required
            >
              <option value="">— เลือกเรือนจำ —</option>
              {#each prisons as p (p.id)}
                <option value={p.id}>{p.nameTh}</option>
              {/each}
            </select>
            {#if fields.prisonId}
              <p class="text-sm text-danger">{fields.prisonId.join(' · ')}</p>
            {/if}
          </div>
        {:else}
          <p class="text-sm text-muted">
            ผู้ดูแลระบบส่วนกลางไม่ผูกกับเรือนจำใด และเห็นข้อมูลทุกเรือนจำ
          </p>
        {/if}

        <Button type="submit" full loading={creating}>สร้างบัญชี</Button>
      </form>
    </Card>
  </div>
</div>
