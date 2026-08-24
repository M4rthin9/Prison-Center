<script lang="ts">
  import { Alert, Button, Card, formatDateTime, formatPhone } from '@pc/ui'
  import { api, toFormError } from '$lib/session.svelte.js'

  interface LinkRow {
    id: string
    customerName: string
    customerPhone: string
    inmateCode: string
    inmateName: string
    prisonName: string
    zoneName: string | null
    relationship: string | null
    verifyStatus: 'pending' | 'verified' | 'rejected'
    requestedAt: number
  }

  let status = $state<'pending' | 'verified' | 'rejected'>('pending')
  let rows = $state<LinkRow[]>([])
  let loading = $state(true)
  let message = $state('')
  let tone = $state<'danger' | 'success'>('success')
  let busyId = $state<string | null>(null)

  async function load() {
    loading = true
    try {
      const res = await api.request<{ items: LinkRow[] }>('/admin/customer-inmates', {
        query: { status }
      })
      rows = res.items
    } catch (err) {
      tone = 'danger'
      message = toFormError(err).message
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void status
    void load()
  })

  async function decide(row: LinkRow, decision: 'verified' | 'rejected') {
    const reason =
      decision === 'rejected' ? (prompt(`เหตุผลที่ปฏิเสธคำขอของ ${row.customerName}`) ?? '') : ''
    if (decision === 'rejected' && reason.trim() === '') return

    busyId = row.id
    message = ''
    try {
      await api.request(`/admin/customer-inmates/${row.id}/verify`, {
        method: 'POST',
        body: { status: decision, reason: reason || undefined }
      })
      tone = 'success'
      message =
        decision === 'verified'
          ? `ยืนยัน ${row.customerName} → ${row.inmateName} แล้ว`
          : `ปฏิเสธคำขอของ ${row.customerName} แล้ว`
      await load()
    } catch (err) {
      tone = 'danger'
      message = toFormError(err).message
    } finally {
      busyId = null
    }
  }

  const TABS = [
    { key: 'pending', label: 'รอตรวจสอบ' },
    { key: 'verified', label: 'ยืนยันแล้ว' },
    { key: 'rejected', label: 'ปฏิเสธ' }
  ] as const
</script>

<div class="space-y-5">
  <div>
    <h1 class="text-2xl font-semibold text-ink">คำขอผูกบัญชีกับผู้ต้องขัง</h1>
    <p class="text-muted">
      การยืนยันนี้คือประตูของทุกอย่างที่เกี่ยวกับเงิน จดหมาย และการเยี่ยม — ตรวจสอบให้แน่ใจก่อนอนุมัติ
    </p>
  </div>

  <div class="flex gap-2">
    {#each TABS as tab (tab.key)}
      <button
        type="button"
        onclick={() => (status = tab.key)}
        class="rounded-full px-4 py-1.5 text-sm transition
               {status === tab.key
          ? 'bg-brand-600 text-white'
          : 'border border-line bg-surface text-ink'}"
      >
        {tab.label}
      </button>
    {/each}
  </div>

  {#if message}
    <Alert {tone} title={message} />
  {/if}

  <Card padded={false}>
    <div class="overflow-x-auto">
      <table class="admin-table">
        <thead>
          <tr>
            <th>ญาติ</th>
            <th>ผู้ต้องขัง</th>
            <th>เรือนจำ / แดน</th>
            <th>ความสัมพันธ์</th>
            <th>ยื่นคำขอ</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr>
              <td>
                <p class="font-medium text-ink">{row.customerName}</p>
                <p class="text-sm text-muted">{formatPhone(row.customerPhone)}</p>
              </td>
              <td>
                <p class="font-medium text-ink">{row.inmateName}</p>
                <p class="text-sm text-muted">{row.inmateCode}</p>
              </td>
              <td>{row.prisonName}{row.zoneName ? ` · ${row.zoneName}` : ''}</td>
              <td>{row.relationship ?? '—'}</td>
              <td class="text-muted">{formatDateTime(row.requestedAt)}</td>
              <td class="text-right whitespace-nowrap">
                {#if row.verifyStatus === 'pending'}
                  <Button
                    size="sm"
                    loading={busyId === row.id}
                    onclick={() => decide(row, 'verified')}
                  >
                    ยืนยัน
                  </Button>
                  <Button size="sm" variant="ghost" onclick={() => decide(row, 'rejected')}>
                    ปฏิเสธ
                  </Button>
                {:else}
                  <span class="text-sm text-muted">—</span>
                {/if}
              </td>
            </tr>
          {:else}
            <tr>
              <td colspan="6" class="py-8 text-center text-muted">
                {loading ? 'กำลังโหลด…' : 'ไม่มีรายการ'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Card>
</div>
