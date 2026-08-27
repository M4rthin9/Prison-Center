<script lang="ts">
  import { Alert, Button, Card, formatDateTime } from '@pc/ui'
  import { api, toFormError } from '$lib/session.svelte.js'
  import type { RetentionReport } from '@pc/contract'

  let report = $state<RetentionReport | null>(null)
  let loading = $state(true)
  let running = $state(false)
  let confirmRun = $state(false)
  let message = $state('')
  let tone = $state<'danger' | 'success'>('success')

  async function preview() {
    loading = true
    message = ''
    try {
      report = await api.admin.pdpa.preview()
    } catch (err) {
      tone = 'danger'
      message = toFormError(err).message
    } finally {
      loading = false
    }
  }

  async function run() {
    running = true
    message = ''
    try {
      report = await api.admin.pdpa.run({ dryRun: false })
      tone = 'success'
      message = `ลบข้อมูลแล้ว ${report.totalRows.toLocaleString('th-TH')} รายการ และไฟล์ ${report.totalFiles.toLocaleString('th-TH')} ไฟล์`
    } catch (err) {
      tone = 'danger'
      message = toFormError(err).message
    } finally {
      running = false
      confirmRun = false
    }
  }

  $effect(() => {
    void preview()
  })
</script>

<header class="mb-6">
  <h1 class="text-xl font-semibold text-ink">การลบข้อมูลตามระยะเวลา (PDPA)</h1>
  <p class="text-sm text-muted">
    ระยะเวลาเก็บข้อมูลกำหนดที่หน้า “ตั้งค่าระบบ” คีย์ <code>pdpa.retention.*</code> —
    ควรรันโหมดทดสอบต่อเนื่องอย่างน้อยหนึ่งเดือนก่อนเปิดใช้งานจริง
  </p>
</header>

{#if message}
  <div class="mb-4"><Alert {tone} title={message} /></div>
{/if}

<Card title="สิ่งที่จะถูกลบ" subtitle={report ? `ณ ${formatDateTime(report.at)}` : ''}>
  {#if loading}
    <p class="text-sm text-muted">กำลังตรวจสอบ…</p>
  {:else if report}
    <div class="mb-4 flex flex-wrap gap-2 text-sm">
      <span class="rounded-full px-2.5 py-1 {report.enabled ? 'bg-ok/15' : 'bg-warn/15'} text-ink">
        {report.enabled ? 'เปิดใช้งานการลบจริงแล้ว' : 'ยังไม่เปิดใช้งานการลบจริง'}
      </span>
      <span class="rounded-full bg-canvas px-2.5 py-1 text-ink">
        {report.dryRun ? 'โหมดทดสอบ — ไม่ได้ลบข้อมูล' : 'ลบข้อมูลจริง'}
      </span>
    </div>

    <div class="overflow-x-auto">
      <table class="w-full text-sm">
        <thead class="text-left text-muted">
          <tr class="border-b border-line">
            <th class="py-2 pr-3 font-medium">ประเภทข้อมูล</th>
            <th class="py-2 pr-3 font-medium">ลบก่อนวันที่</th>
            <th class="py-2 pr-3 text-right font-medium">รายการ</th>
            <th class="py-2 text-right font-medium">ไฟล์</th>
          </tr>
        </thead>
        <tbody>
          {#each report.actions as action (action.key)}
            <tr class="border-b border-line last:border-0">
              <td class="py-2 pr-3 text-ink">{action.label}</td>
              <td class="py-2 pr-3 text-muted">{formatDateTime(action.cutoffAt)}</td>
              <td class="py-2 pr-3 text-right tabular-nums text-ink">
                {action.rows.toLocaleString('th-TH')}
              </td>
              <td class="py-2 text-right tabular-nums text-muted">
                {action.files.toLocaleString('th-TH')}
              </td>
            </tr>
          {/each}
        </tbody>
        <tfoot>
          <tr class="border-t-2 border-line font-semibold">
            <td class="py-2 pr-3 text-ink" colspan="2">รวม</td>
            <td class="py-2 pr-3 text-right tabular-nums text-ink">
              {report.totalRows.toLocaleString('th-TH')}
            </td>
            <td class="py-2 text-right tabular-nums text-ink">
              {report.totalFiles.toLocaleString('th-TH')}
            </td>
          </tr>
        </tfoot>
      </table>
    </div>

    <div class="mt-5 flex gap-2">
      <Button variant="secondary" onclick={preview} loading={loading}>ตรวจสอบใหม่</Button>
      {#if confirmRun}
        <Button variant="danger" onclick={run} loading={running}>ยืนยันลบข้อมูลจริง</Button>
        <Button variant="ghost" onclick={() => (confirmRun = false)}>ยกเลิก</Button>
      {:else}
        <Button
          variant="danger"
          disabled={!report.enabled || report.totalRows === 0}
          onclick={() => (confirmRun = true)}
        >
          ลบข้อมูลจริง
        </Button>
      {/if}
    </div>
    {#if !report.enabled}
      <p class="mt-2 text-xs text-muted">
        เปิดใช้งานได้ที่คีย์ <code>pdpa.retention.enabled</code> หลังกรมเห็นชอบระยะเวลาเก็บข้อมูล
      </p>
    {/if}
  {/if}
</Card>
