<script lang="ts">
  import type {
    LetterBatch,
    LetterDetail,
    LetterStatus,
    LetterSummary,
    LetterSummaryTotals
  } from '@pc/contract'
  import { Alert, Button, Card, formatDateTime } from '@pc/ui'
  import { api, session, toFormError } from '$lib/session.svelte.js'

  const STATUS_LABEL: Record<LetterStatus, string> = {
    draft: 'ฉบับร่าง',
    queued: 'รอพิมพ์',
    pending_print: 'อยู่ในรอบพิมพ์',
    printed: 'พิมพ์แล้ว',
    dispatched: 'นำส่งแดนแล้ว',
    delivered: 'ถึงมือแล้ว',
    rejected: 'ไม่อนุญาต / ยกเลิก'
  }
  const BATCH_LABEL: Record<LetterBatch['status'], string> = {
    queued: 'กำลังเข้าคิวสร้างไฟล์',
    rendering: 'กำลังสร้างไฟล์',
    ready: 'พร้อมพิมพ์',
    printed: 'พิมพ์แล้ว',
    failed: 'สร้างไฟล์ไม่สำเร็จ'
  }
  const TABS: { key: LetterStatus | ''; label: string }[] = [
    { key: 'queued', label: 'รอพิมพ์' },
    { key: 'pending_print', label: 'อยู่ในรอบพิมพ์' },
    { key: 'printed', label: 'พิมพ์แล้ว' },
    { key: 'delivered', label: 'ถึงมือแล้ว' },
    { key: 'rejected', label: 'ไม่อนุญาต' },
    { key: '', label: 'ทั้งหมด' }
  ]

  let status = $state<LetterStatus | ''>('queued')
  let q = $state('')
  let rows = $state<LetterSummary[]>([])
  let nextCursor = $state<string | null>(null)
  let totals = $state<LetterSummaryTotals | null>(null)
  let batches = $state<LetterBatch[]>([])
  let open = $state<LetterDetail | null>(null)

  let loading = $state(true)
  let busyId = $state<string | null>(null)
  let message = $state('')
  let tone = $state<'danger' | 'success'>('success')

  const canOperate = $derived(
    ['super_admin', 'prison_admin', 'letter_operator'].includes(session.me?.role ?? '')
  )
  const queuedCount = $derived(rows.filter((r) => r.status === 'queued').length)

  function say(text: string, kind: 'danger' | 'success' = 'success') {
    tone = kind
    message = text
  }

  async function load(cursor?: string) {
    loading = true
    try {
      const page = await api.admin.letters.list({
        status: status || undefined,
        q: q.trim() || undefined,
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

  async function loadSide() {
    try {
      const [t, b] = await Promise.all([
        api.admin.letters.summary(),
        api.admin.letters.batches({ limit: 8 })
      ])
      totals = t
      batches = b.items
    } catch (err) {
      say(toFormError(err).message, 'danger')
    }
  }

  $effect(() => {
    void loadSide()
  })

  $effect(() => {
    void status
    const term = q
    const timer = setTimeout(() => void load(), term ? 250 : 0)
    return () => clearTimeout(timer)
  })

  async function show(row: LetterSummary) {
    busyId = row.id
    try {
      open = await api.admin.letters.get(row.id)
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busyId = null
    }
  }

  /**
   * Creating a batch pins the letters immediately and hands the drawing to the
   * job queue, so the file appears a moment later rather than blocking here.
   */
  async function makeBatch() {
    busyId = 'batch'
    try {
      const batch = await api.admin.letters.createBatch({})
      say(`สร้างรอบพิมพ์ ${batch.batchNo} (${batch.letterCount} ฉบับ) แล้ว — กำลังสร้างไฟล์`)
      await Promise.all([load(), loadSide()])
      // The renderer runs on the job queue; poll once for the finished file.
      setTimeout(() => void loadSide(), 2500)
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busyId = null
    }
  }

  async function markPrinted(batch: LetterBatch) {
    busyId = batch.id
    try {
      await api.admin.letters.markBatchPrinted(batch.id)
      say(`บันทึกว่าพิมพ์รอบ ${batch.batchNo} แล้ว และแจ้งญาติเรียบร้อย`)
      await Promise.all([load(), loadSide()])
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busyId = null
    }
  }

  async function setStatus(id: string, next: 'printed' | 'dispatched' | 'delivered' | 'rejected') {
    const reason =
      next === 'rejected' ? (prompt('เหตุผลที่ไม่อนุญาตให้ส่งจดหมายฉบับนี้') ?? '').trim() : ''
    if (next === 'rejected' && reason === '') return

    busyId = id
    try {
      const detail = await api.admin.letters.setStatus(id, {
        status: next,
        reason: reason || undefined
      })
      open = detail
      say(
        next === 'rejected'
          ? `ไม่อนุญาตจดหมาย ${detail.letterNo} และคืนสิทธิ์ให้ญาติแล้ว`
          : `อัปเดตจดหมาย ${detail.letterNo} เป็น "${STATUS_LABEL[next]}" แล้ว`
      )
      await Promise.all([load(), loadSide()])
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busyId = null
    }
  }

  /* ── scan-reply intake ─────────────────────────────────────────────── */

  let scanning = $state(false)
  let manualLetterNo = $state('')

  async function onScanPicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return

    scanning = true
    try {
      const result = await api.admin.letters.scanReply(file, {
        letterNo: manualLetterNo.trim() || undefined
      })
      say(result.message, result.letter ? 'success' : 'danger')
      if (result.letter) {
        manualLetterNo = ''
        open = result.letter
        await Promise.all([load(), loadSide()])
      }
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      scanning = false
    }
  }
</script>

<div class="space-y-5">
  <div>
    <h1 class="text-2xl font-semibold text-ink">จดหมายอิเล็กทรอนิกส์</h1>
    <p class="text-muted">
      คิวพิมพ์ รอบพิมพ์ A4 และการนำเข้าจดหมายตอบกลับที่สแกนแล้ว — {session.scopeLabel}
    </p>
  </div>

  {#if message}
    <Alert {tone} title={message} />
  {/if}

  {#if totals}
    <div class="grid gap-3 sm:grid-cols-4">
      {#each [['รอพิมพ์', String(totals.awaitingPrintCount)], ['พิมพ์แล้ว', String(totals.printedCount)], ['ถึงมือแล้ว', String(totals.deliveredCount)], ['ขายแพ็กเกจได้', (totals.creditsSoldSatang / 100).toLocaleString( 'th-TH', { minimumFractionDigits: 2 } )]] as [label, value] (label)}
        <div class="rounded-xl border border-line bg-surface px-4 py-3">
          <p class="text-sm text-muted">{label}</p>
          <p class="text-2xl font-semibold text-ink">{value}</p>
        </div>
      {/each}
    </div>
  {/if}

  <div class="grid gap-4 lg:grid-cols-2">
    <Card title="รอบพิมพ์" subtitle="หนึ่งรอบ = กระดาษหนึ่งปึกสำหรับเดินหนึ่งแดน" padded={false}>
      {#snippet actions()}
        <Button
          size="sm"
          disabled={!canOperate || queuedCount === 0}
          loading={busyId === 'batch'}
          onclick={makeBatch}
        >
          สร้างรอบพิมพ์ ({queuedCount})
        </Button>
      {/snippet}
      <div class="overflow-x-auto">
        <table class="admin-table">
          <thead>
            <tr>
              <th>เลขที่รอบ</th>
              <th>แดน</th>
              <th>จำนวน</th>
              <th>สถานะ</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each batches as batch (batch.id)}
              <tr>
                <td class="font-mono text-sm">{batch.batchNo}</td>
                <td>{batch.zoneName ?? 'ทุกแดน'}</td>
                <td>{batch.letterCount}</td>
                <td>
                  {BATCH_LABEL[batch.status]}
                  {#if batch.format === 'html' && batch.status !== 'failed'}
                    <span class="block text-xs text-muted"
                      >ไฟล์ HTML — สั่งพิมพ์ A4 จากเบราว์เซอร์</span
                    >
                  {/if}
                  {#if batch.status === 'failed' && batch.lastError}
                    <span class="block text-xs text-danger">{batch.lastError}</span>
                  {/if}
                </td>
                <td class="space-x-2 text-right whitespace-nowrap">
                  {#if batch.fileUrl}
                    <a
                      class="text-sm text-brand-700 underline"
                      href={api.admin.letters.batchFileUrl(batch.id)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      เปิดไฟล์
                    </a>
                  {/if}
                  {#if canOperate && batch.status === 'ready'}
                    <Button
                      size="sm"
                      loading={busyId === batch.id}
                      onclick={() => markPrinted(batch)}
                    >
                      พิมพ์แล้ว
                    </Button>
                  {/if}
                </td>
              </tr>
            {:else}
              <tr><td colspan="5" class="py-6 text-center text-muted">ยังไม่มีรอบพิมพ์</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </Card>

    <Card
      title="นำเข้าจดหมายตอบกลับ"
      subtitle="สแกนทั้งแผ่น — ระบบอ่าน QR บนใบตอบกลับเพื่อหาว่าเป็นของครอบครัวไหน"
    >
      <label
        class="flex h-24 cursor-pointer items-center justify-center rounded-xl border
               border-dashed border-line text-sm text-brand-700"
      >
        {scanning ? 'กำลังอ่าน QR…' : 'เลือกไฟล์สแกน (JPEG/PNG)'}
        <input
          type="file"
          accept="image/*"
          class="hidden"
          disabled={!canOperate || scanning}
          onchange={onScanPicked}
        />
      </label>
      <label class="mt-3 block space-y-1.5">
        <span class="text-sm text-muted">
          ถ้า QR เลอะจนอ่านไม่ได้ กรอกเลขที่จดหมายต้นทางไว้ก่อนเลือกไฟล์
        </span>
        <input
          bind:value={manualLetterNo}
          placeholder="เช่น KLP-L2608-0007"
          class="w-full rounded-xl border border-line bg-white px-3 py-2 font-mono text-sm text-ink"
        />
      </label>
      {#if !canOperate}
        <p class="mt-3 text-sm text-muted">ต้องมีสิทธิ์งานจดหมายจึงจะนำเข้าได้</p>
      {/if}
    </Card>
  </div>

  <div class="flex flex-wrap items-center gap-2">
    {#each TABS as tab (tab.label)}
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
    <input
      type="search"
      bind:value={q}
      placeholder="เลขที่จดหมาย / ชื่อผู้ต้องขัง / ชื่อญาติ"
      class="ml-auto w-72 rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink"
    />
  </div>

  <Card padded={false}>
    <div class="overflow-x-auto">
      <table class="admin-table">
        <thead>
          <tr>
            <th>เลขที่จดหมาย</th>
            <th>ทิศทาง</th>
            <th>ผู้ต้องขัง</th>
            <th>ญาติ</th>
            <th>รอบพิมพ์</th>
            <th>สถานะ</th>
            <th>เขียนเมื่อ</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr>
              <td class="font-mono text-sm">{row.letterNo}</td>
              <td class="text-sm">
                {row.direction === 'to_prison' ? 'เข้าเรือนจำ' : 'กลับบ้าน'}
              </td>
              <td>
                <p class="font-medium text-ink">{row.inmateName ?? '—'}</p>
                <p class="text-sm text-muted">
                  {row.inmateCode ?? '—'}{row.zoneName ? ` · ${row.zoneName}` : ''}
                </p>
              </td>
              <td class="text-ink">{row.customerName ?? '—'}</td>
              <td class="font-mono text-sm text-muted">{row.batchNo ?? '—'}</td>
              <td>{STATUS_LABEL[row.status]}</td>
              <td class="text-muted">{formatDateTime(row.createdAt)}</td>
              <td class="text-right">
                <Button
                  size="sm"
                  variant="ghost"
                  loading={busyId === row.id}
                  onclick={() => show(row)}
                >
                  เปิด
                </Button>
              </td>
            </tr>
          {:else}
            <tr>
              <td colspan="8" class="py-8 text-center text-muted">
                {loading ? 'กำลังโหลด…' : 'ไม่มีจดหมายในกลุ่มนี้'}
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

{#if open}
  <div class="fixed inset-0 z-40 flex">
    <button
      type="button"
      class="flex-1 cursor-default bg-black/30"
      aria-label="ปิด"
      onclick={() => (open = null)}
    ></button>
    <aside class="w-[32rem] max-w-full overflow-y-auto border-l border-line bg-surface p-5">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="font-mono text-sm text-muted">{open.letterNo}</p>
          <h2 class="text-xl font-semibold text-ink">
            {open.direction === 'to_prison' ? 'จดหมายเข้าเรือนจำ' : 'จดหมายตอบกลับบ้าน'}
          </h2>
          <p class="text-sm text-muted">{STATUS_LABEL[open.status]}</p>
        </div>
        <Button size="sm" variant="ghost" onclick={() => (open = null)}>ปิด</Button>
      </div>

      <dl class="mt-4 space-y-2 border-t border-line pt-4 text-sm">
        <div class="flex justify-between gap-4">
          <dt class="text-muted">ผู้ต้องขัง</dt>
          <dd class="text-ink">{open.inmateName ?? '—'} ({open.inmateCode ?? '—'})</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">แดน</dt>
          <dd class="text-ink">{open.zoneName ?? '—'}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">ญาติ</dt>
          <dd class="text-ink">{open.customerName ?? '—'}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">รอบพิมพ์</dt>
          <dd class="font-mono text-ink">{open.batchNo ?? '—'}</dd>
        </div>
        {#if open.replyToLetterNo}
          <div class="flex justify-between gap-4">
            <dt class="text-muted">ตอบกลับจดหมาย</dt>
            <dd class="font-mono text-ink">{open.replyToLetterNo}</dd>
          </div>
        {/if}
        <div class="flex justify-between gap-4">
          <dt class="text-muted">พิมพ์เมื่อ</dt>
          <dd class="text-ink">{formatDateTime(open.printedAt)}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">ถึงมือเมื่อ</dt>
          <dd class="text-ink">{formatDateTime(open.deliveredAt)}</dd>
        </div>
      </dl>

      {#if open.rejectedReason}
        <div class="mt-3"><Alert tone="danger" title={open.rejectedReason} /></div>
      {/if}

      {#if open.bodyText}
        <div class="mt-4 border-t border-line pt-4">
          <p class="mb-2 text-sm text-muted">เนื้อหา</p>
          <p class="whitespace-pre-wrap rounded-xl bg-canvas px-3 py-2 leading-relaxed text-ink">
            {open.bodyText}
          </p>
        </div>
      {/if}

      {#if open.scanUrl}
        <div class="mt-4 border-t border-line pt-4">
          <p class="mb-2 text-sm text-muted">ไฟล์สแกนที่นำเข้า</p>
          <img
            src={api.admin.letters.scanUrl(open.id)}
            alt="จดหมายตอบกลับ"
            class="w-full rounded-xl border border-line"
          />
        </div>
      {/if}

      {#if open.attachments.length > 0}
        <p class="mt-4 border-t border-line pt-4 text-sm text-muted">
          รูปแนบ {open.attachments.length} รูป (พิมพ์รวมอยู่ในแผ่นเดียวกัน)
        </p>
      {/if}

      {#if canOperate && open.status !== 'delivered' && open.status !== 'rejected'}
        <div class="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
          {#if open.status === 'printed'}
            <Button loading={busyId === open.id} onclick={() => setStatus(open!.id, 'dispatched')}>
              นำส่งแดนแล้ว
            </Button>
          {/if}
          {#if open.status === 'printed' || open.status === 'dispatched'}
            <Button loading={busyId === open.id} onclick={() => setStatus(open!.id, 'delivered')}>
              ส่งถึงมือแล้ว
            </Button>
          {/if}
          <Button variant="ghost" onclick={() => setStatus(open!.id, 'rejected')}>
            ไม่อนุญาต (คืนสิทธิ์)
          </Button>
        </div>
      {/if}
    </aside>
  </div>
{/if}
