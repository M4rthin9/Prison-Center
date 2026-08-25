<script lang="ts">
  import { Alert, Button, Card, formatDate } from '@pc/ui'
  import type { InmateRow, InmateStatus, PrisonSummary, Zone } from '@pc/contract'
  import { api, session, toFormError } from '$lib/session.svelte.js'

  const INPUT = 'w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-ink'
  const LABEL = 'text-sm font-medium text-ink'

  const STATUS_LABEL: Record<InmateStatus, string> = {
    active: 'อยู่ในเรือนจำ',
    transferred: 'ย้ายเรือนจำ',
    released: 'พ้นโทษ',
    deceased: 'เสียชีวิต'
  }

  let prisons = $state<PrisonSummary[]>([])
  let zones = $state<Zone[]>([])
  let prisonId = $state('')
  let zoneId = $state('')
  let status = $state<InmateStatus | ''>('')
  let q = $state('')
  let includeDeleted = $state(false)

  let rows = $state<InmateRow[]>([])
  let nextCursor = $state<string | null>(null)
  let loading = $state(true)
  let busyId = $state<string | null>(null)
  let message = $state('')
  let tone = $state<'danger' | 'success'>('success')

  let showCreate = $state(false)
  let form = $state({ inmateCode: '', fullName: '', zoneId: '' })
  let saving = $state(false)

  /** The row being edited inline; null when the table is read-only. */
  let editing = $state<InmateRow | null>(null)
  let editForm = $state({ inmateCode: '', fullName: '', zoneId: '', status: 'active' })

  const canEdit = $derived(
    session.me?.role === 'super_admin' || session.me?.role === 'prison_admin'
  )
  const effectivePrisonId = $derived(prisonId || session.me?.prisonId || '')

  function say(text: string, kind: 'danger' | 'success' = 'success') {
    tone = kind
    message = text
  }

  async function loadZones() {
    if (!effectivePrisonId) return
    zones = (await api.prisons.get(effectivePrisonId)).zones
  }

  async function load(cursor?: string) {
    loading = true
    try {
      const page = await api.admin.inmates.list({
        prisonId: prisonId || undefined,
        zoneId: zoneId || undefined,
        status: status || undefined,
        q: q.trim() || undefined,
        includeDeleted: includeDeleted || undefined,
        cursor,
        limit: 50
      })
      rows = cursor ? [...rows, ...page.items] : page.items
      nextCursor = page.nextCursor
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void (async () => {
      if (session.isSuperAdmin) {
        prisons = (await api.prisons.list()).items
        prisonId ||= prisons[0]?.id ?? ''
      }
      await loadZones()
    })()
  })

  $effect(() => {
    // Re-runs whenever a filter changes. The search box is debounced by hand so
    // a fast typist does not fire ten keyset queries.
    void prisonId
    void zoneId
    void status
    void includeDeleted
    const term = q
    const timer = setTimeout(() => void load(), term ? 250 : 0)
    return () => clearTimeout(timer)
  })

  async function create(event: SubmitEvent) {
    event.preventDefault()
    saving = true
    try {
      await api.admin.inmates.create({
        prisonId: prisonId || undefined,
        inmateCode: form.inmateCode.trim(),
        fullName: form.fullName.trim(),
        zoneId: form.zoneId || null,
        status: 'active'
      })
      say(`เพิ่ม ${form.fullName} แล้ว`)
      form = { inmateCode: '', fullName: '', zoneId: '' }
      showCreate = false
      await load()
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      saving = false
    }
  }

  function startEdit(row: InmateRow) {
    editing = row
    editForm = {
      inmateCode: row.inmateCode,
      fullName: row.fullName,
      zoneId: row.zoneId ?? '',
      status: row.status
    }
  }

  async function act(row: InmateRow, run: () => Promise<unknown>, done: string) {
    busyId = row.id
    try {
      await run()
      say(done)
      editing = null
      await load()
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busyId = null
    }
  }

  const saveEdit = (row: InmateRow) =>
    act(
      row,
      () =>
        api.admin.inmates.update(row.id, {
          inmateCode: editForm.inmateCode.trim(),
          fullName: editForm.fullName.trim(),
          zoneId: editForm.zoneId || null,
          status: editForm.status as InmateStatus
        }),
      `บันทึก ${editForm.fullName} แล้ว`
    )

  function remove(row: InmateRow) {
    if (!confirm(`ลบ ${row.fullName} (${row.inmateCode}) ออกจากรายชื่อ?`)) return
    void act(
      row,
      () => api.admin.inmates.remove(row.id),
      `ลบ ${row.fullName} แล้ว — ประวัติเดิมยังอยู่ในระบบ`
    )
  }

  function transfer(row: InmateRow) {
    const typed = prompt(
      `ย้าย ${row.fullName} ไปเรือนจำใด? พิมพ์รหัสเรือนจำ (${prisons.map((p) => p.code).join(', ')})`
    )
    if (!typed) return
    const to = prisons.find((p) => p.code.toLowerCase() === typed.trim().toLowerCase())
    if (!to) {
      say(`ไม่พบรหัสเรือนจำ "${typed}"`, 'danger')
      return
    }
    void act(
      row,
      () => api.admin.inmates.transfer(row.id, { toPrisonId: to.id }),
      `ย้าย ${row.fullName} ไป ${to.nameTh} แล้ว — คำสั่งซื้อเดิมยังคงแดนที่บันทึกไว้`
    )
  }
</script>

<div class="space-y-5">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-2xl font-semibold text-ink">ผู้ต้องขัง</h1>
      <p class="text-muted">ข้อมูลหลักที่ทุกอย่างอ้างถึง — {session.scopeLabel}</p>
    </div>
    <div class="flex items-center gap-2">
      <a
        class="rounded-xl border border-line bg-surface px-4 py-2.5 text-sm text-ink hover:bg-canvas"
        href="/inmates/import"
      >
        นำเข้าจากไฟล์
      </a>
      {#if canEdit}
        <Button onclick={() => (showCreate = !showCreate)}>
          {showCreate ? 'ปิดฟอร์ม' : 'เพิ่มผู้ต้องขัง'}
        </Button>
      {/if}
    </div>
  </div>

  {#if message}
    <Alert {tone} title={message} />
  {/if}

  {#if showCreate}
    <Card>
      <form class="grid gap-4 md:grid-cols-4" onsubmit={create}>
        <label class="block space-y-1.5">
          <span class={LABEL}>เลขทะเบียน</span>
          <input class={INPUT} bind:value={form.inmateCode} required />
        </label>
        <label class="block space-y-1.5">
          <span class={LABEL}>ชื่อ-สกุล</span>
          <input class={INPUT} bind:value={form.fullName} required />
        </label>
        <label class="block space-y-1.5">
          <span class={LABEL}>แดน</span>
          <select class={INPUT} bind:value={form.zoneId}>
            <option value="">— ไม่ระบุ —</option>
            {#each zones as zone (zone.id)}
              <option value={zone.id}>{zone.name}</option>
            {/each}
          </select>
        </label>
        <div class="flex items-end">
          <Button type="submit" loading={saving}>บันทึก</Button>
        </div>
      </form>
    </Card>
  {/if}

  <Card>
    <div class="grid gap-3 md:grid-cols-5">
      {#if session.isSuperAdmin}
        <label class="block space-y-1.5">
          <span class={LABEL}>เรือนจำ</span>
          <select class={INPUT} bind:value={prisonId} onchange={() => void loadZones()}>
            {#each prisons as p (p.id)}
              <option value={p.id}>{p.nameTh}</option>
            {/each}
          </select>
        </label>
      {/if}
      <label class="block space-y-1.5">
        <span class={LABEL}>แดน</span>
        <select class={INPUT} bind:value={zoneId}>
          <option value="">ทุกแดน</option>
          {#each zones as zone (zone.id)}
            <option value={zone.id}>{zone.name}</option>
          {/each}
        </select>
      </label>
      <label class="block space-y-1.5">
        <span class={LABEL}>สถานะ</span>
        <select class={INPUT} bind:value={status}>
          <option value="">ทุกสถานะ</option>
          {#each Object.entries(STATUS_LABEL) as [key, label] (key)}
            <option value={key}>{label}</option>
          {/each}
        </select>
      </label>
      <label class="block space-y-1.5">
        <span class={LABEL}>ค้นหา</span>
        <input class={INPUT} type="search" placeholder="ชื่อ หรือ เลขทะเบียน" bind:value={q} />
      </label>
      <label class="flex items-end gap-2 pb-3 text-sm text-ink">
        <input type="checkbox" bind:checked={includeDeleted} />
        แสดงรายการที่ถูกลบ
      </label>
    </div>
  </Card>

  <Card padded={false}>
    <div class="overflow-x-auto">
      <table class="admin-table">
        <thead>
          <tr>
            <th>เลขทะเบียน</th>
            <th>ชื่อ-สกุล</th>
            <th>แดน / กองงาน</th>
            <th>สถานะ</th>
            <th>ข้อมูลจากกรมฯ</th>
            <th>ญาติที่ผูก</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr class={row.deletedAt ? 'opacity-60' : ''}>
              {#if editing?.id === row.id}
                <td><input class={INPUT} bind:value={editForm.inmateCode} /></td>
                <td><input class={INPUT} bind:value={editForm.fullName} /></td>
                <td>
                  <select class={INPUT} bind:value={editForm.zoneId}>
                    <option value="">— ไม่ระบุ —</option>
                    {#each zones as zone (zone.id)}
                      <option value={zone.id}>{zone.name}</option>
                    {/each}
                  </select>
                </td>
                <td>
                  <select class={INPUT} bind:value={editForm.status}>
                    {#each Object.entries(STATUS_LABEL) as [key, label] (key)}
                      <option value={key}>{label}</option>
                    {/each}
                  </select>
                </td>
                <td colspan="2" class="text-sm text-muted">
                  การแก้ด้วยมือจะถูกคงไว้เมื่อนำเข้าไฟล์รอบถัดไป
                </td>
                <td class="text-right whitespace-nowrap">
                  <Button size="sm" loading={busyId === row.id} onclick={() => void saveEdit(row)}>
                    บันทึก
                  </Button>
                  <Button size="sm" variant="ghost" onclick={() => (editing = null)}>ยกเลิก</Button>
                </td>
              {:else}
                <td class="font-mono text-sm">{row.inmateCode}</td>
                <td>
                  <p class="font-medium text-ink">{row.fullName}</p>
                  {#if row.isLocallyEdited}
                    <p class="text-xs text-muted">แก้ไขโดยเจ้าหน้าที่</p>
                  {/if}
                </td>
                <td>
                  {row.zoneName ?? '—'}{row.workDivisionName ? ` · ${row.workDivisionName}` : ''}
                </td>
                <td>
                  {STATUS_LABEL[row.status]}
                  {#if row.deletedAt}
                    <span class="text-xs text-danger">(ลบแล้ว)</span>
                  {/if}
                </td>
                <td class="text-sm text-muted">
                  {#if row.externalId}
                    {row.externalId}
                    <span class="block text-xs">ซิงก์ {formatDate(row.syncedAt)}</span>
                  {:else}
                    เพิ่มด้วยมือ
                  {/if}
                </td>
                <td>{row.linkCount}</td>
                <td class="text-right whitespace-nowrap">
                  {#if canEdit}
                    {#if row.deletedAt}
                      <Button
                        size="sm"
                        variant="ghost"
                        loading={busyId === row.id}
                        onclick={() =>
                          void act(
                            row,
                            () => api.admin.inmates.restore(row.id),
                            `กู้คืน ${row.fullName} แล้ว`
                          )}
                      >
                        กู้คืน
                      </Button>
                    {:else}
                      <Button size="sm" variant="ghost" onclick={() => startEdit(row)}>แก้ไข</Button>
                      {#if session.isSuperAdmin}
                        <Button size="sm" variant="ghost" onclick={() => transfer(row)}>ย้าย</Button>
                      {/if}
                      <Button size="sm" variant="ghost" onclick={() => remove(row)}>ลบ</Button>
                    {/if}
                  {:else}
                    <span class="text-sm text-muted">—</span>
                  {/if}
                </td>
              {/if}
            </tr>
          {:else}
            <tr>
              <td colspan="7" class="py-8 text-center text-muted">
                {loading ? 'กำลังโหลด…' : 'ไม่พบผู้ต้องขังตามเงื่อนไขนี้'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Card>

  {#if nextCursor}
    <div class="text-center">
      <Button variant="ghost" {loading} onclick={() => void load(nextCursor ?? undefined)}>
        โหลดเพิ่ม
      </Button>
    </div>
  {/if}
</div>
