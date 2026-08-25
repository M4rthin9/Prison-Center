<script lang="ts">
  import { Alert, Button, Card, formatDateTime } from '@pc/ui'
  import type {
    ImportPreview,
    ImportRowResult,
    ImportRunSummary,
    MissingPolicy,
    PrisonSummary
  } from '@pc/contract'
  import { api, session, toFormError } from '$lib/session.svelte.js'

  const INPUT = 'w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-ink'
  const LABEL = 'text-sm font-medium text-ink'

  const RESULT_LABEL: Record<ImportRowResult, string> = {
    created: 'เพิ่มใหม่',
    updated: 'อัปเดต',
    skipped: 'ไม่เปลี่ยนแปลง',
    conflict: 'ข้อมูลขัดแย้ง',
    error: 'ข้อมูลไม่ถูกต้อง'
  }
  const RESULT_TONE: Record<ImportRowResult, string> = {
    created: 'bg-brand-50 text-brand-800',
    updated: 'bg-brand-50 text-brand-800',
    skipped: 'bg-canvas text-muted',
    conflict: 'bg-danger/10 text-danger',
    error: 'bg-danger/10 text-danger'
  }

  let prisons = $state<PrisonSummary[]>([])
  let prisonId = $state('')
  let source = $state('doc_xlsx')
  let createZones = $state(false)
  let missingPolicy = $state<MissingPolicy>('ignore')
  let file = $state<File | null>(null)

  let preview = $state<ImportPreview | null>(null)
  let applied = $state(false)
  let runs = $state<ImportRunSummary[]>([])
  let filter = $state<ImportRowResult | ''>('')
  let busy = $state(false)
  let message = $state('')
  let tone = $state<'danger' | 'success' | 'info'>('info')

  const counts = $derived(preview?.run ?? null)
  const visibleRows = $derived(
    preview ? preview.rows.filter((r) => !filter || r.result === filter) : []
  )
  const hasWork = $derived(
    !!counts && counts.rowsCreated + counts.rowsUpdated > 0
  )

  function say(text: string, kind: 'danger' | 'success' | 'info' = 'info') {
    tone = kind
    message = text
  }

  async function loadRuns() {
    runs = (await api.admin.inmates.runs({ prisonId: prisonId || undefined, limit: 10 })).items
  }

  $effect(() => {
    void (async () => {
      if (session.isSuperAdmin) {
        prisons = (await api.prisons.list()).items
        prisonId ||= prisons[0]?.id ?? ''
      }
      await loadRuns()
    })()
  })

  async function dryRun(event: SubmitEvent) {
    event.preventDefault()
    if (!file) return
    busy = true
    message = ''
    applied = false
    try {
      const result = await api.admin.inmates.dryRun(file, {
        prisonId: prisonId || undefined,
        source,
        createZones,
        missingPolicy,
        filename: file.name
      })
      preview = result
      say(
        `ตรวจสอบแล้ว ${result.run.rowsTotal} แถว — ยังไม่มีการเขียนข้อมูล`,
        result.run.rowsErrored > 0 ? 'danger' : 'info'
      )
      await loadRuns()
    } catch (err) {
      preview = null
      say(toFormError(err).message, 'danger')
    } finally {
      busy = false
    }
  }

  async function apply() {
    if (!preview) return
    busy = true
    try {
      const result = await api.admin.inmates.apply(preview.run.id)
      preview = result
      applied = true
      say(
        `นำเข้าแล้ว: เพิ่ม ${result.run.rowsCreated} · อัปเดต ${result.run.rowsUpdated} · ` +
          `ไม่เปลี่ยนแปลง ${result.run.rowsSkipped} · ต้องแก้ไข ${result.run.rowsErrored}`,
        'success'
      )
      await loadRuns()
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busy = false
    }
  }

  async function openRun(run: ImportRunSummary) {
    busy = true
    try {
      const res = await api.admin.inmates.run(run.id, { limit: 200 })
      preview = {
        run: res.run,
        columnMap: {},
        unmappedHeaders: [],
        rows: res.rows,
        missing: [],
        missingTotal: 0
      }
      applied = res.run.status === 'applied'
      say(`เปิดรอบการนำเข้าเมื่อ ${formatDateTime(res.run.startedAt)}`)
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busy = false
    }
  }
</script>

<div class="space-y-5">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-2xl font-semibold text-ink">นำเข้ารายชื่อผู้ต้องขัง</h1>
      <p class="text-muted">
        ขั้นแรกคือตรวจสอบเสมอ — ระบบจะแสดงผลต่างทีละแถวก่อน แล้วจึงกดยืนยันเขียนข้อมูล
      </p>
    </div>
    <a
      class="rounded-xl border border-line bg-surface px-4 py-2.5 text-sm text-ink hover:bg-canvas"
      href="/inmates"
    >
      กลับไปรายชื่อ
    </a>
  </div>

  {#if message}
    <Alert {tone} title={message} />
  {/if}

  <Card title="เลือกไฟล์" subtitle="รองรับ .xlsx และ .csv (อ่านได้ทั้ง UTF-8 และ TIS-620)">
    <form class="grid gap-4 md:grid-cols-2" onsubmit={dryRun}>
      {#if session.isSuperAdmin}
        <label class="block space-y-1.5">
          <span class={LABEL}>เรือนจำปลายทาง</span>
          <select class={INPUT} bind:value={prisonId} onchange={() => void loadRuns()}>
            {#each prisons as p (p.id)}
              <option value={p.id}>{p.nameTh}</option>
            {/each}
          </select>
        </label>
      {/if}

      <label class="block space-y-1.5">
        <span class={LABEL}>ไฟล์รายชื่อ</span>
        <input
          class={INPUT}
          type="file"
          accept=".xlsx,.csv,.txt"
          required
          onchange={(e) => (file = e.currentTarget.files?.[0] ?? null)}
        />
      </label>

      <label class="block space-y-1.5">
        <span class={LABEL}>แหล่งข้อมูล (external_source)</span>
        <input class={INPUT} bind:value={source} />
        <span class="text-xs text-muted">
          ใช้จับคู่รหัสอ้างอิงกับรอบก่อนหน้า — เปลี่ยนค่านี้เท่ากับเริ่มชุดข้อมูลใหม่
        </span>
      </label>

      <label class="block space-y-1.5">
        <span class={LABEL}>ผู้ต้องขังที่ไม่มีในไฟล์</span>
        <select class={INPUT} bind:value={missingPolicy}>
          <option value="ignore">ไม่ทำอะไร (แนะนำ)</option>
          <option value="mark_transferred">ตั้งสถานะเป็น "ย้ายเรือนจำ"</option>
        </select>
        <span class="text-xs text-muted">ไฟล์ที่ส่งมาไม่ครบไม่ควรถูกอ่านว่าปล่อยตัวยกเรือนจำ</span>
      </label>

      <label class="flex items-center gap-2 text-sm text-ink">
        <input type="checkbox" bind:checked={createZones} />
        สร้างแดน / กองงานที่ยังไม่มีในระบบให้อัตโนมัติ
      </label>

      <div class="flex items-end justify-end">
        <Button type="submit" loading={busy} disabled={!file}>ตรวจสอบไฟล์</Button>
      </div>
    </form>
  </Card>

  {#if preview}
    <Card title="ผลต่างที่จะเกิดขึ้น" subtitle={preview.run.fileName ?? ''}>
      <div class="grid gap-3 sm:grid-cols-5">
        {#each [['เพิ่มใหม่', preview.run.rowsCreated], ['อัปเดต', preview.run.rowsUpdated], ['ไม่เปลี่ยนแปลง', preview.run.rowsSkipped], ['ต้องแก้ไข', preview.run.rowsErrored], ['ทั้งหมด', preview.run.rowsTotal]] as [label, value] (label)}
          <div class="rounded-xl border border-line bg-canvas px-4 py-3">
            <p class="text-sm text-muted">{label}</p>
            <p class="text-2xl font-semibold text-ink">{value}</p>
          </div>
        {/each}
      </div>

      {#if preview.unmappedHeaders.length > 0}
        <p class="mt-3 text-sm text-muted">
          คอลัมน์ที่ระบบไม่รู้จัก (เก็บไว้ในบันทึกแต่ไม่ได้นำเข้า):
          {preview.unmappedHeaders.join(', ')}
        </p>
      {/if}

      {#if preview.missingTotal > 0}
        <p class="mt-3 text-sm text-muted">
          มีผู้ต้องขัง {preview.missingTotal} คนในระบบที่ไม่ปรากฏในไฟล์นี้
          {missingPolicy === 'ignore' ? '— จะไม่ถูกแตะต้อง' : '— จะถูกตั้งสถานะย้ายเรือนจำ'}
        </p>
      {/if}

      <div class="mt-4 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onclick={() => (filter = '')}
          class="rounded-full px-4 py-1.5 text-sm transition
                 {filter === '' ? 'bg-brand-600 text-white' : 'border border-line bg-surface'}"
        >
          ทุกแถว
        </button>
        {#each Object.entries(RESULT_LABEL) as [key, label] (key)}
          <button
            type="button"
            onclick={() => (filter = key as ImportRowResult)}
            class="rounded-full px-4 py-1.5 text-sm transition
                   {filter === key ? 'bg-brand-600 text-white' : 'border border-line bg-surface'}"
          >
            {label}
          </button>
        {/each}

        {#if preview.run.hasErrorReport}
          <a
            class="ml-auto rounded-xl border border-line bg-surface px-4 py-2 text-sm text-ink"
            href={api.admin.inmates.errorReportUrl(preview.run.id)}
            download
          >
            ดาวน์โหลดรายการที่ต้องแก้ไข (.xlsx)
          </a>
        {/if}
      </div>

      <div class="mt-4 overflow-x-auto">
        <table class="admin-table">
          <thead>
            <tr>
              <th>แถวที่</th>
              <th>ผล</th>
              <th>เลขทะเบียน</th>
              <th>ชื่อ-สกุล</th>
              <th>รายละเอียด</th>
            </tr>
          </thead>
          <tbody>
            {#each visibleRows as row (row.rowNo)}
              <tr>
                <td class="text-muted">{row.rowNo}</td>
                <td>
                  <span class="rounded-full px-2.5 py-1 text-xs {RESULT_TONE[row.result]}">
                    {RESULT_LABEL[row.result]}
                  </span>
                </td>
                <td class="font-mono text-sm">{row.inmateCode ?? '—'}</td>
                <td>{row.fullName ?? '—'}</td>
                <td class="text-sm text-muted">{row.message ?? '—'}</td>
              </tr>
            {:else}
              <tr>
                <td colspan="5" class="py-8 text-center text-muted">ไม่มีแถวในกลุ่มนี้</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>

      <div class="mt-4 flex items-center justify-end gap-3">
        {#if applied}
          <p class="text-sm text-muted">รอบนี้ยืนยันแล้ว</p>
        {:else}
          <p class="mr-auto text-sm text-muted">
            แถวที่ขัดแย้งหรือไม่ถูกต้องจะถูกข้าม ส่วนที่เหลือจะถูกเขียนลงฐานข้อมูล
          </p>
          <Button loading={busy} disabled={!hasWork} onclick={apply}>ยืนยันการนำเข้า</Button>
        {/if}
      </div>
    </Card>
  {/if}

  <Card title="ประวัติการนำเข้า" padded={false}>
    <div class="overflow-x-auto">
      <table class="admin-table">
        <thead>
          <tr>
            <th>เมื่อ</th>
            <th>ไฟล์</th>
            <th>เรือนจำ</th>
            <th>สถานะ</th>
            <th>เพิ่ม / อัปเดต / ข้าม / ต้องแก้</th>
            <th>ผู้ทำรายการ</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each runs as run (run.id)}
            <tr>
              <td class="text-muted">{formatDateTime(run.startedAt)}</td>
              <td>{run.fileName ?? '—'}</td>
              <td>{run.prisonName}</td>
              <td>{run.status === 'applied' ? 'ยืนยันแล้ว' : 'ตรวจสอบเท่านั้น'}</td>
              <td class="font-mono text-sm">
                {run.rowsCreated} / {run.rowsUpdated} / {run.rowsSkipped} / {run.rowsErrored}
              </td>
              <td>{run.runByName ?? '—'}</td>
              <td class="text-right">
                <Button size="sm" variant="ghost" onclick={() => void openRun(run)}>ดูผลต่าง</Button>
              </td>
            </tr>
          {:else}
            <tr>
              <td colspan="7" class="py-8 text-center text-muted">ยังไม่เคยนำเข้าไฟล์</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Card>
</div>
