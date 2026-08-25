<script lang="ts">
  import type { PaymentDetail, PaymentState, PaymentSummary } from '@pc/contract'
  import { PAYMENT_RAIL_LABEL, PAYMENT_STATE_LABEL } from '@pc/contract'
  import { Alert, Button, Card, formatBaht, formatDateTime } from '@pc/ui'
  import { api, toFormError } from '$lib/session.svelte.js'

  let rows = $state<PaymentSummary[]>([])
  let nextCursor = $state<string | null>(null)
  let status = $state<PaymentState | ''>('awaiting_verify')
  let q = $state('')
  let loading = $state(true)
  let message = $state('')
  let tone = $state<'danger' | 'success'>('success')

  /* the review drawer */
  let open = $state<PaymentDetail | null>(null)
  let slipUrl = $state<string | null>(null)
  let working = $state(false)
  let formError = $state('')
  let transRef = $state('')
  let amountBaht = $state('')
  let transferredAt = $state('')
  let sendingBank = $state('')

  const TABS = [
    { key: 'awaiting_verify', label: 'รอตรวจสอบ' },
    { key: 'succeeded', label: 'สำเร็จ' },
    { key: 'pending', label: 'รอชำระ' },
    { key: 'failed', label: 'ไม่ผ่าน' },
    { key: 'refunded', label: 'คืนเงิน' },
    { key: '', label: 'ทั้งหมด' }
  ] as const

  const query = () => ({ status: status || undefined, q: q.trim() || undefined, limit: 25 })

  $effect(() => {
    const filters = query()
    loading = true
    api.admin.payments
      .list(filters)
      .then((r) => {
        rows = r.items
        nextCursor = r.nextCursor
        message = ''
      })
      .catch((err) => {
        tone = 'danger'
        message = toFormError(err).message
      })
      .finally(() => (loading = false))
  })

  async function loadMore() {
    if (!nextCursor) return
    const r = await api.admin.payments.list({ ...query(), cursor: nextCursor })
    rows = [...rows, ...r.items]
    nextCursor = r.nextCursor
  }

  /** `datetime-local` is Bangkok wall time; the API stores UTC epoch ms. */
  const toLocalInput = (ms: number) => {
    const d = new Date(ms - new Date().getTimezoneOffset() * 60_000)
    return d.toISOString().slice(0, 16)
  }

  async function review(row: PaymentSummary) {
    formError = ''
    slipUrl = null
    open = await api.admin.payments.get(row.id)
    // Pre-filled from the mini-QR and the expected charge — a reviewer who
    // just clicks through still has to have seen matching numbers.
    transRef = open.transRef ?? ''
    amountBaht = (open.chargeSatang / 100).toFixed(2)
    transferredAt = toLocalInput(open.slipUploadedAt ?? Date.now())
    sendingBank = open.sendingBank ?? ''

    if (open.slipUrl) {
      // The slip is behind the API session, so it cannot be an <img src>.
      const blob = await api.request<Blob>(`/admin/payments/${row.id}/slip`)
      slipUrl = URL.createObjectURL(blob)
    }
  }

  function close() {
    if (slipUrl) URL.revokeObjectURL(slipUrl)
    slipUrl = null
    open = null
  }

  function patch(updated: PaymentDetail, note: string) {
    rows = rows.map((r) =>
      r.id === updated.id
        ? { ...r, status: updated.status, transRef: updated.transRef, settledAt: updated.settledAt }
        : r
    )
    tone = 'success'
    message = `${updated.paymentNo} — ${note}`
    close()
  }

  async function verify() {
    if (!open) return
    working = true
    formError = ''
    try {
      const updated = await api.admin.payments.verify(open.id, {
        transRef: transRef.trim(),
        // Parsed as baht, stored as satang — rounding here, never in the API.
        transferAmountSatang: Math.round(Number(amountBaht) * 100),
        transferredAt: new Date(transferredAt).getTime(),
        sendingBank: sendingBank.trim() || null
      })
      patch(updated, 'ยืนยันการชำระเงินแล้ว')
    } catch (err) {
      formError = toFormError(err).message
    } finally {
      working = false
    }
  }

  async function reject() {
    if (!open) return
    const reason = (prompt(`เหตุผลที่ปฏิเสธสลิปของ ${open.paymentNo}`) ?? '').trim()
    if (!reason) return
    working = true
    try {
      patch(await api.admin.payments.reject(open.id, { reason }), 'ปฏิเสธสลิปแล้ว')
    } catch (err) {
      formError = toFormError(err).message
    } finally {
      working = false
    }
  }

  async function refund() {
    if (!open) return
    const reason = (prompt(`เหตุผลที่คืนเงินรายการ ${open.paymentNo}`) ?? '').trim()
    if (!reason) return
    working = true
    try {
      patch(await api.admin.payments.refund(open.id, { reason }), 'บันทึกการคืนเงินแล้ว')
    } catch (err) {
      formError = toFormError(err).message
    } finally {
      working = false
    }
  }

  const amountMismatch = $derived(
    open !== null && Math.round(Number(amountBaht) * 100) !== open.chargeSatang
  )
</script>

<div class="space-y-5">
  <div>
    <h1 class="text-2xl font-semibold text-ink">การชำระเงิน</h1>
    <p class="text-muted">
      ตรวจสอบสลิปด้วยตาแล้วกรอกสิ่งที่เห็น — ยอดต้องตรงทุกสตางค์
      และเลขอ้างอิงหนึ่งใบใช้ได้ครั้งเดียว
    </p>
  </div>

  {#if message}<Alert {tone} title={message} />{/if}

  <div class="flex flex-wrap items-center gap-2">
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
    <input
      type="search"
      bind:value={q}
      placeholder="เลขที่รายการ / เลขอ้างอิง"
      class="ml-auto w-64 rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink"
    />
  </div>

  <Card padded={false}>
    <div class="overflow-x-auto">
      <table class="admin-table">
        <thead>
          <tr>
            <th>เลขที่รายการ</th>
            <th>คำสั่งซื้อ</th>
            <th>ผู้ชำระ</th>
            <th>ช่องทาง</th>
            <th>ยอดที่ต้องโอน</th>
            <th>เลขอ้างอิง</th>
            <th>สถานะ</th>
            <th>สร้างเมื่อ</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr>
              <td class="font-mono text-sm text-ink">{row.paymentNo}</td>
              <td>
                {#if row.orderNo}
                  <a class="font-mono text-sm text-brand-700" href="/orders/{row.purposeId}">
                    {row.orderNo}
                  </a>
                {:else}
                  <span class="text-muted">—</span>
                {/if}
              </td>
              <td>
                <p class="text-ink">{row.customerName}</p>
                <p class="text-sm text-muted">{row.customerPhone}</p>
              </td>
              <td class="text-sm text-muted">{PAYMENT_RAIL_LABEL[row.rail]}</td>
              <td class="font-medium text-ink">{formatBaht(row.chargeSatang)}</td>
              <td class="font-mono text-sm text-muted">{row.transRef ?? '—'}</td>
              <td>{PAYMENT_STATE_LABEL[row.status]}</td>
              <td class="text-muted">{formatDateTime(row.createdAt)}</td>
              <td class="text-right">
                <Button size="sm" variant="secondary" onclick={() => review(row)}>
                  {row.status === 'awaiting_verify' ? 'ตรวจสอบ' : 'ดู'}
                </Button>
              </td>
            </tr>
          {:else}
            <tr>
              <td colspan="9" class="py-8 text-center text-muted">
                {loading ? 'กำลังโหลด…' : 'ไม่มีรายการชำระเงิน'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Card>

  {#if nextCursor}
    <Button variant="secondary" onclick={loadMore}>ดูเพิ่มเติม</Button>
  {/if}
</div>

{#if open}
  <div class="fixed inset-0 z-40 flex justify-end bg-black/40">
    <button type="button" class="flex-1 cursor-default" aria-label="ปิด" onclick={close}></button>
    <section class="w-full max-w-2xl overflow-y-auto bg-canvas p-6">
      <header class="mb-4 flex items-start justify-between gap-4">
        <div>
          <h2 class="text-xl font-semibold text-ink">{open.paymentNo}</h2>
          <p class="text-sm text-muted">
            {PAYMENT_RAIL_LABEL[open.rail]} · {open.channelName} · {PAYMENT_STATE_LABEL[
              open.status
            ]}
          </p>
        </div>
        <Button variant="ghost" size="sm" onclick={close}>ปิด</Button>
      </header>

      {#if formError}<div class="mb-4"><Alert tone="danger" title={formError} /></div>{/if}

      <div class="grid gap-4 lg:grid-cols-2">
        <Card title="สลิป" padded={false}>
          {#if slipUrl}
            <img src={slipUrl} alt="สลิปโอนเงินของ {open.customerName}" class="w-full" />
          {:else}
            <p class="px-5 py-8 text-center text-muted">ยังไม่มีสลิป</p>
          {/if}
        </Card>

        <div class="space-y-4">
          <Card title="สิ่งที่ระบบคาดหวัง">
            <dl class="space-y-2 text-sm">
              <div class="flex justify-between gap-4">
                <dt class="text-muted">ยอดคำสั่งซื้อ</dt>
                <dd class="text-ink">{formatBaht(open.amountSatang)}</dd>
              </div>
              {#if open.amountSaltSatang > 0}
                <div class="flex justify-between gap-4">
                  <dt class="text-muted">เศษสตางค์อ้างอิง</dt>
                  <dd class="text-ink">+{open.amountSaltSatang} สตางค์</dd>
                </div>
              {/if}
              <div class="flex justify-between gap-4 border-t border-line pt-2">
                <dt class="font-medium text-ink">ยอดที่ต้องโอน</dt>
                <dd class="font-semibold text-ink">{formatBaht(open.chargeSatang)}</dd>
              </div>
              {#if open.qrRef1}
                <div class="flex justify-between gap-4">
                  <dt class="text-muted">Ref1 / Ref2</dt>
                  <dd class="font-mono text-ink">{open.qrRef1} / {open.qrRef2 ?? '—'}</dd>
                </div>
              {/if}
              <div class="flex justify-between gap-4">
                <dt class="text-muted">บัญชีปลายทาง</dt>
                <dd class="text-ink">{open.bankName ?? '—'} {open.accountNo ?? ''}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="text-muted">QR หมดอายุ</dt>
                <dd class="text-ink">{formatDateTime(open.expiresAt)}</dd>
              </div>
            </dl>
          </Card>

          {#if open.status === 'awaiting_verify'}
            <Card title="กรอกสิ่งที่เห็นบนสลิป">
              <div class="space-y-3">
                <label class="block space-y-1.5">
                  <span class="text-sm font-medium text-ink">เลขอ้างอิงรายการ (trans ref)</span>
                  <input
                    bind:value={transRef}
                    class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 font-mono
                           text-ink"
                  />
                </label>
                <label class="block space-y-1.5">
                  <span class="text-sm font-medium text-ink">ยอดโอนตามสลิป (บาท)</span>
                  <input
                    bind:value={amountBaht}
                    inputmode="decimal"
                    class="w-full rounded-xl border bg-white px-3.5 py-2.5 text-ink
                           {amountMismatch ? 'border-danger' : 'border-line'}"
                  />
                  {#if amountMismatch}
                    <span class="text-sm text-danger">
                      ไม่ตรงกับยอดที่ต้องโอน {formatBaht(open.chargeSatang)} — ระบบจะปฏิเสธ
                    </span>
                  {/if}
                </label>
                <label class="block space-y-1.5">
                  <span class="text-sm font-medium text-ink">เวลาโอนตามสลิป</span>
                  <input
                    type="datetime-local"
                    bind:value={transferredAt}
                    class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-ink"
                  />
                </label>
                <label class="block space-y-1.5">
                  <span class="text-sm font-medium text-ink">ธนาคารต้นทาง (ถ้ามี)</span>
                  <input
                    bind:value={sendingBank}
                    class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-ink"
                  />
                </label>
              </div>

              <div class="mt-4 flex gap-2">
                <Button loading={working} onclick={verify}>ยืนยันการชำระเงิน</Button>
                <Button variant="danger" disabled={working} onclick={reject}>ปฏิเสธสลิป</Button>
              </div>
            </Card>
          {:else if open.status === 'succeeded'}
            <Card title="ยืนยันแล้ว">
              <dl class="space-y-2 text-sm">
                <div class="flex justify-between gap-4">
                  <dt class="text-muted">เลขอ้างอิง</dt>
                  <dd class="font-mono text-ink">{open.transRef}</dd>
                </div>
                <div class="flex justify-between gap-4">
                  <dt class="text-muted">ยอดโอน</dt>
                  <dd class="text-ink">{formatBaht(open.transferAmountSatang ?? 0)}</dd>
                </div>
                <div class="flex justify-between gap-4">
                  <dt class="text-muted">เวลาโอน</dt>
                  <dd class="text-ink">{formatDateTime(open.transferredAt)}</dd>
                </div>
                <div class="flex justify-between gap-4">
                  <dt class="text-muted">ผู้ตรวจสอบ</dt>
                  <dd class="text-ink">
                    {open.verifiedByName ?? '—'} · {formatDateTime(open.verifiedAt)}
                  </dd>
                </div>
              </dl>
              <div class="mt-4">
                <Button variant="danger" disabled={working} onclick={refund}>
                  บันทึกการคืนเงิน
                </Button>
              </div>
            </Card>
          {:else if open.rejectReason}
            <Alert tone="warning" title="เหตุผลล่าสุด">{open.rejectReason}</Alert>
          {/if}
        </div>
      </div>
    </section>
  </div>
{/if}
