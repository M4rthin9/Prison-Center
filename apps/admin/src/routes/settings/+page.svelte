<script lang="ts">
  import { Alert, Button, Card, formatDateTime } from '@pc/ui'
  import { api, session, toFormError } from '$lib/session.svelte.js'
  import type { PrisonSummary } from '@pc/contract'

  interface SettingView {
    key: string
    label: string
    scope: 'global' | 'prison'
    exposed: boolean
    value: unknown
    isDefault: boolean
  }

  let items = $state<SettingView[]>([])
  let prisons = $state<PrisonSummary[]>([])
  let prisonId = $state('')
  let loading = $state(true)
  let message = $state('')
  let tone = $state<'danger' | 'success'>('success')
  /** key → the JSON text being edited, so a bad edit never clobbers the row. */
  let drafts = $state<Record<string, string>>({})
  let savingKey = $state<string | null>(null)

  async function load() {
    loading = true
    try {
      const [res, prisonRes] = await Promise.all([
        api.request<{ items: SettingView[] }>('/admin/settings', {
          query: { prisonId: prisonId || undefined }
        }),
        api.prisons.list()
      ])
      items = res.items
      prisons = prisonRes.items
      drafts = Object.fromEntries(res.items.map((i) => [i.key, JSON.stringify(i.value, null, 2)]))
    } catch (err) {
      tone = 'danger'
      message = toFormError(err).message
    } finally {
      loading = false
    }
  }

  $effect(() => {
    if (!session.isSuperAdmin && session.me?.prisonId) prisonId = session.me.prisonId
  })

  $effect(() => {
    void prisonId
    void load()
  })

  async function save(item: SettingView) {
    savingKey = item.key
    message = ''
    let parsed: unknown
    try {
      parsed = JSON.parse(drafts[item.key] ?? '')
    } catch {
      tone = 'danger'
      message = `${item.label}: ค่าที่กรอกไม่ใช่ JSON ที่ถูกต้อง`
      savingKey = null
      return
    }

    try {
      await api.request(`/admin/settings/${item.key}`, {
        method: 'PUT',
        query: item.scope === 'prison' && prisonId ? { prisonId } : undefined,
        body: { value: parsed }
      })
      tone = 'success'
      message = `บันทึก ${item.label} แล้ว`
      await load()
    } catch (err) {
      const e = toFormError(err)
      tone = 'danger'
      message = `${item.label}: ${e.message}${
        Object.keys(e.fields).length ? ` (${Object.values(e.fields).flat().join(', ')})` : ''
      }`
    } finally {
      savingKey = null
    }
  }

  const groups = $derived(
    items.reduce<Record<string, SettingView[]>>((acc, item) => {
      const group = item.key.split('.')[0] ?? 'other'
      ;(acc[group] ??= []).push(item)
      return acc
    }, {})
  )

  const GROUP_LABEL: Record<string, string> = {
    contact: 'ข้อมูลติดต่อ',
    shop: 'ร้านค้า',
    order: 'คำสั่งซื้อ',
    visit: 'การเยี่ยม',
    letter: 'จดหมาย',
    payment: 'การชำระเงิน',
    inmate: 'ข้อมูลผู้ต้องขัง',
    pdpa: 'ระยะเวลาเก็บข้อมูล (PDPA)',
    line: 'LINE',
    features: 'ฟีเจอร์'
  }
</script>

<div class="space-y-5">
  <div class="flex items-end justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold text-ink">ตั้งค่าระบบ</h1>
      <p class="text-muted">
        ทุกคีย์ถูกประกาศไว้ในโค้ดพร้อม schema และค่าเริ่มต้น — คีย์ที่ไม่รู้จักจะถูกปฏิเสธ
      </p>
    </div>

    {#if session.isSuperAdmin}
      <div>
        <label class="mb-1 block text-sm text-muted" for="scope">ขอบเขต</label>
        <select
          id="scope"
          bind:value={prisonId}
          class="h-11 w-64 rounded-xl border border-line bg-white px-3"
        >
          <option value="">ค่าส่วนกลาง</option>
          {#each prisons as p (p.id)}
            <option value={p.id}>{p.nameTh}</option>
          {/each}
        </select>
      </div>
    {:else}
      <div class="text-right">
        <p class="text-sm text-muted">ขอบเขต</p>
        <p class="font-medium text-ink">{session.scopeLabel}</p>
      </div>
    {/if}
  </div>

  {#if prisonId && session.isSuperAdmin}
    <Alert tone="info" title="กำลังแก้ค่าเฉพาะเรือนจำ">
      คีย์ที่มีขอบเขต “เรือนจำ” จะถูกบันทึกเป็นค่าเฉพาะของเรือนจำนี้
      ส่วนคีย์ส่วนกลางยังคงแก้ได้เฉพาะผู้ดูแลระบบส่วนกลาง
    </Alert>
  {/if}

  {#if message}
    <Alert {tone} title={message} />
  {/if}

  {#if loading}
    <p class="text-muted">กำลังโหลด…</p>
  {:else}
    <div class="space-y-5">
      {#each Object.entries(groups) as [group, list] (group)}
        <Card title={GROUP_LABEL[group] ?? group}>
          <div class="space-y-5">
            {#each list as item (item.key)}
              <div class="grid gap-3 lg:grid-cols-[18rem_1fr_auto] lg:items-start">
                <div>
                  <p class="font-medium text-ink">{item.label}</p>
                  <p class="font-mono text-xs text-muted">{item.key}</p>
                  <p class="mt-1 text-xs text-muted">
                    {item.scope === 'prison' ? 'ตั้งแยกรายเรือนจำได้' : 'ค่าส่วนกลาง'}
                    {item.exposed ? ' · เปิดเผยต่อผู้ใช้ทั่วไป' : ''}
                    {item.isDefault ? ' · ค่าเริ่มต้น' : ' · ถูกแก้ไขแล้ว'}
                  </p>
                </div>

                <textarea
                  bind:value={drafts[item.key]}
                  rows={(drafts[item.key]?.split('\n').length ?? 1) > 6 ? 8 : 2}
                  spellcheck="false"
                  class="w-full rounded-xl border border-line bg-white px-3 py-2 font-mono text-sm"
                ></textarea>

                <Button
                  size="sm"
                  variant="secondary"
                  loading={savingKey === item.key}
                  onclick={() => save(item)}
                >
                  บันทึก
                </Button>
              </div>
            {/each}
          </div>
        </Card>
      {/each}
    </div>
  {/if}

  <p class="text-sm text-muted">
    ค่าถูกตรวจสอบด้วย Zod ฝั่งเซิร์ฟเวอร์ก่อนบันทึกเสมอ และการแก้ไขทุกครั้งถูกบันทึกลง audit log
    ({formatDateTime(Date.now())})
  </p>
</div>
