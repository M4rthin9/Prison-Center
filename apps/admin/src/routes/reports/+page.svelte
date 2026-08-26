<script lang="ts">
  import type { ReportGrouping, ReportJob, ReportKind } from '@pc/contract'
  import { REPORT_LABEL } from '@pc/contract'
  import { Alert, Button, Card, formatDateTime } from '@pc/ui'
  import { api, session, toFormError } from '$lib/session.svelte.js'

  const KINDS: { kind: ReportKind; hint: string }[] = [
    { kind: 'sales', hint: 'หนึ่งบรรทัดต่อคำสั่งซื้อ' },
    { kind: 'sales_detail', hint: 'หนึ่งบรรทัดต่อรายการสินค้า' },
    { kind: 'products', hint: 'สินค้า × แดน × กองงาน (เฉพาะที่ชำระแล้ว)' },
    { kind: 'visits', hint: 'นับตามวันเข้าเยี่ยม' },
    { kind: 'letters', hint: 'ขาเข้าและขาออก แยกตามแดน' },
    { kind: 'payments', hint: 'สำเร็จ / ไม่สำเร็จ แยกตามช่องทาง' },
    { kind: 'deposits', hint: 'ยอดที่รับแล้วและยอดที่โอนเข้าบัญชี' }
  ]
  const GROUPINGS: { key: ReportGrouping; label: string }[] = [
    { key: 'month', label: 'รายเดือน' },
    { key: 'year', label: 'รายปี' },
    { key: 'none', label: 'ไม่แยกช่วง' }
  ]
  const STATUS_LABEL: Record<string, string> = {
    pending: 'เข้าคิวแล้ว',
    running: 'กำลังสร้าง',
    succeeded: 'พร้อมดาวน์โหลด',
    failed: 'ไม่สำเร็จ',
    cancelled: 'ยกเลิก'
  }

  const today = new Date(Date.now() + 7 * 3600_000).toISOString().slice(0, 10)

  let from = $state(today.slice(0, 8) + '01')
  let to = $state(today)
  let groupBy = $state<ReportGrouping>('month')
  let jobs = $state<ReportJob[]>([])
  let busyKind = $state<ReportKind | null>(null)
  let busyDownload = $state<string | null>(null)
  let message = $state('')
  let tone = $state<'danger' | 'success'>('success')
  /** Set while any job is still pending/running — drives the poll. */
  let polling = $state(false)

  const canExport = $derived(
    ['super_admin', 'prison_admin', 'finance'].includes(session.me?.role ?? '')
  )

  function say(text: string, kind: 'danger' | 'success' = 'success') {
    tone = kind
    message = text
  }

  async function load() {
    try {
      const res = await api.admin.reports.list({ limit: 25 })
      jobs = res.items
      polling = jobs.some((j) => j.status === 'pending' || j.status === 'running')
    } catch (err) {
      say(toFormError(err).message, 'danger')
    }
  }

  $effect(() => {
    void load()
  })

  // The queue runs on a 5-second tick server-side, so polling faster than that
  // just burns requests.
  $effect(() => {
    if (!polling) return
    const timer = setInterval(() => void load(), 3000)
    return () => clearInterval(timer)
  })

  /**
   * The download endpoint needs the access token, and the token lives in a
   * closure rather than a cookie — so a plain `<a href>` would 401. Fetch it
   * through the client and hand the browser a blob instead.
   */
  async function download(job: ReportJob) {
    busyDownload = job.id
    try {
      const blob = await api.request<Blob>(`/admin/reports/${job.id}/download`)
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = job.filename ?? `${job.label}.xlsx`
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busyDownload = null
    }
  }

  async function run(kind: ReportKind) {
    busyKind = kind
    try {
      const job = await api.admin.reports.run(kind, { from, to, groupBy })
      say(`สั่งสร้าง "${job.label}" แล้ว — ไฟล์จะพร้อมในอีกสักครู่`)
      polling = true
      await load()
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busyKind = null
    }
  }
</script>

<div class="space-y-5">
  <div>
    <h1 class="text-2xl font-semibold text-ink">รายงาน</h1>
    <p class="text-muted">
      รายงานทั้ง 7 ฉบับตาม p.12 — สร้างเป็นไฟล์ Excel ในคิวงาน ไม่ต้องรอหน้าจอ · {session.scopeLabel}
    </p>
  </div>

  {#if message}
    <Alert {tone} title={message} />
  {/if}

  {#if !canExport}
    <Alert
      tone="info"
      title="บัญชีนี้ดูรายงานที่สั่งไว้ได้ แต่สั่งสร้างรายงานใหม่ไม่ได้"
    />
  {/if}

  <Card title="ช่วงเวลา" subtitle="วันที่ตามเวลาไทย นับรวมทั้งวันเริ่มต้นและวันสิ้นสุด">
    <div class="flex flex-wrap items-end gap-3">
      <label class="text-sm text-muted">
        ตั้งแต่
        <input
          type="date"
          bind:value={from}
          class="mt-1 block rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink"
        />
      </label>
      <label class="text-sm text-muted">
        ถึง
        <input
          type="date"
          bind:value={to}
          class="mt-1 block rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink"
        />
      </label>
      <label class="text-sm text-muted">
        จัดกลุ่ม
        <select
          bind:value={groupBy}
          class="mt-1 block rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink"
        >
          {#each GROUPINGS as g (g.key)}
            <option value={g.key}>{g.label}</option>
          {/each}
        </select>
      </label>
      <p class="text-xs text-muted">
        การจัดกลุ่มมีผลกับรายงานที่ 3–7 เท่านั้น รายงานการขายทั้งสองฉบับเป็นรายบรรทัดเสมอ
      </p>
    </div>
  </Card>

  <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
    {#each KINDS as item, i (item.kind)}
      <div class="rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3">
        <p class="text-xs text-muted">รายงานที่ {i + 1}</p>
        <p class="font-medium text-ink">{REPORT_LABEL[item.kind]}</p>
        <p class="mt-0.5 text-sm text-muted">{item.hint}</p>
        <div class="mt-3">
          <Button
            size="sm"
            disabled={!canExport}
            loading={busyKind === item.kind}
            onclick={() => run(item.kind)}
          >
            สร้างไฟล์ Excel
          </Button>
        </div>
      </div>
    {/each}
  </div>

  <Card title="รายงานที่สั่งไว้ล่าสุด" padded={false}>
    <div class="overflow-x-auto">
      <table class="admin-table">
        <thead>
          <tr>
            <th>รายงาน</th>
            <th>ช่วงวันที่</th>
            <th>สถานะ</th>
            <th>จำนวนแถว</th>
            <th>สั่งเมื่อ</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each jobs as job (job.id)}
            <tr>
              <td>
                <p class="font-medium text-ink">{job.label}</p>
                <p class="text-sm text-muted">
                  โดย {job.requestedBy ?? '—'}
                </p>
              </td>
              <td class="text-muted">{job.filters?.from} – {job.filters?.to}</td>
              <td>
                {STATUS_LABEL[job.status] ?? job.status}
                {#if job.error}
                  <p class="text-sm text-danger">{job.error}</p>
                {/if}
              </td>
              <td>{job.rowCount ?? '—'}</td>
              <td class="text-muted">{formatDateTime(job.createdAt)}</td>
              <td class="text-right">
                {#if job.status === 'succeeded'}
                  <Button
                    size="sm"
                    variant="ghost"
                    loading={busyDownload === job.id}
                    onclick={() => download(job)}
                  >
                    ดาวน์โหลด
                  </Button>
                {:else}
                  <span class="text-sm text-muted">—</span>
                {/if}
              </td>
            </tr>
          {:else}
            <tr>
              <td colspan="6" class="py-10 text-center text-muted">ยังไม่มีรายงานที่สั่งไว้</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Card>
</div>
