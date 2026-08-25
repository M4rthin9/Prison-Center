<script lang="ts">
  import type {
    DepositCard,
    DepositDetail,
    DepositStatus,
    DepositSummary,
    DepositSummaryTotals
  } from '@pc/contract'
  import { Alert, Button, Card, formatBaht, formatDateTime, formatPhone } from '@pc/ui'
  import { api, session, toFormError } from '$lib/session.svelte.js'

  const STATUS_LABEL: Record<DepositStatus, string> = {
    pending: 'รอชำระ / รอสลิป',
    reviewing: 'กำลังตรวจสอบ',
    completed: 'เสร็จสิ้น',
    rejected: 'ไม่สำเร็จ',
    cancelled: 'ยกเลิก'
  }
  const TABS: { key: DepositStatus | ''; label: string }[] = [
    { key: 'reviewing', label: 'รอโอนเข้าบัญชี' },
    { key: 'pending', label: 'รอชำระ / รอสลิป' },
    { key: 'completed', label: 'เสร็จสิ้น' },
    { key: 'rejected', label: 'ไม่สำเร็จ' },
    { key: '', label: 'ทั้งหมด' }
  ]

  let status = $state<DepositStatus | ''>('reviewing')
  let q = $state('')
  let rows = $state<DepositSummary[]>([])
  let nextCursor = $state<string | null>(null)
  let totals = $state<DepositSummaryTotals | null>(null)
  let cards = $state<DepositCard[]>([])
  let open = $state<DepositDetail | null>(null)

  let loading = $state(true)
  let busyId = $state<string | null>(null)
  let message = $state('')
  let tone = $state<'danger' | 'success'>('success')

  const canReview = $derived(
    ['super_admin', 'prison_admin', 'finance'].includes(session.me?.role ?? '')
  )

  function say(text: string, kind: 'danger' | 'success' = 'success') {
    tone = kind
    message = text
  }

  async function load(cursor?: string) {
    loading = true
    try {
      const page = await api.admin.deposits.list({
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
      const [t, c] = await Promise.all([
        api.admin.deposits.summary(),
        api.admin.deposits.cards({ status: 'pending' })
      ])
      totals = t
      cards = c.items
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

  async function show(row: DepositSummary) {
    busyId = row.id
    try {
      open = await api.admin.deposits.get(row.id)
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busyId = null
    }
  }

  async function review(id: string, next: 'reviewing' | 'completed' | 'rejected') {
    const reason =
      next === 'rejected' ? (prompt('เหตุผลที่ปฏิเสธรายการฝากเงินนี้') ?? '').trim() : ''
    if (next === 'rejected' && reason === '') return

    busyId = id
    try {
      const detail = await api.admin.deposits.review(id, {
        status: next,
        reason: reason || undefined
      })
      open = detail
      say(
        next === 'completed'
          ? `โอน ${formatBaht(detail.amountSatang)} เข้าบัญชี ${detail.inmateName} แล้ว`
          : next === 'rejected'
            ? `ปฏิเสธรายการ ${detail.depositNo} แล้ว`
            : `อัปเดตสถานะ ${detail.depositNo} แล้ว`
      )
      await Promise.all([load(), loadSide()])
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busyId = null
    }
  }

  async function reviewCard(card: DepositCard, next: 'approved' | 'rejected') {
    const reason =
      next === 'rejected' ? (prompt(`เหตุผลที่ปฏิเสธบัตรของ ${card.customerName}`) ?? '').trim() : ''
    if (next === 'rejected' && reason === '') return

    busyId = card.id
    try {
      const updated = await api.admin.deposits.reviewCard(card.id, {
        status: next,
        reason: reason || undefined
      })
      say(
        next === 'approved'
          ? `อนุมัติบัตรฝากเงิน ${updated.cardNo} ให้ ${updated.customerName} แล้ว`
          : `ปฏิเสธคำขอของ ${updated.customerName} แล้ว`
      )
      await loadSide()
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busyId = null
    }
  }
</script>

<div class="space-y-5">
  <div>
    <h1 class="text-2xl font-semibold text-ink">การฝากเงิน</h1>
    <p class="text-muted">
      สลิปผ่านแล้ว = ได้รับเงิน · "เสร็จสิ้น" = โอนเข้าบัญชีผู้ต้องขังในเรือนจำแล้ว — {session.scopeLabel}
    </p>
  </div>

  {#if message}
    <Alert {tone} title={message} />
  {/if}

  {#if totals}
    <div class="grid gap-3 sm:grid-cols-4">
      {#each [['รอชำระ / รอสลิป', String(totals.pendingCount), 'รายการ'], ['รอโอนเข้าบัญชี', String(totals.reviewingCount), 'รายการ'], ['ได้รับเงินแล้ว', formatBaht(totals.receivedSatang), 'รวมทั้งช่วง'], ['โอนเข้าบัญชีแล้ว', formatBaht(totals.completedSatang), 'รวมทั้งช่วง']] as [label, value, hint] (label)}
        <div class="rounded-xl border border-line bg-surface px-4 py-3">
          <p class="text-sm text-muted">{label}</p>
          <p class="text-2xl font-semibold text-ink">{value}</p>
          <p class="text-xs text-muted">{hint}</p>
        </div>
      {/each}
    </div>
  {/if}

  {#if cards.length > 0}
    <Card title="คำขอทำบัตรฝากเงิน" subtitle="อนุมัติครั้งเดียวต่อคู่ญาติ–ผู้ต้องขัง" padded={false}>
      <div class="overflow-x-auto">
        <table class="admin-table">
          <thead>
            <tr>
              <th>ญาติ</th>
              <th>ผู้ต้องขัง</th>
              <th>แดน</th>
              <th>ยื่นเมื่อ</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {#each cards as card (card.id)}
              <tr>
                <td>
                  <p class="font-medium text-ink">{card.customerName}</p>
                  <p class="text-sm text-muted">{formatPhone(card.customerPhone)}</p>
                </td>
                <td>
                  <p class="font-medium text-ink">{card.inmateName}</p>
                  <p class="text-sm text-muted">{card.inmateCode}</p>
                </td>
                <td>{card.zoneName ?? '—'}</td>
                <td class="text-muted">{formatDateTime(card.createdAt)}</td>
                <td class="text-right whitespace-nowrap">
                  {#if canReview}
                    <Button
                      size="sm"
                      loading={busyId === card.id}
                      onclick={() => reviewCard(card, 'approved')}
                    >
                      อนุมัติ
                    </Button>
                    <Button size="sm" variant="ghost" onclick={() => reviewCard(card, 'rejected')}>
                      ปฏิเสธ
                    </Button>
                  {:else}
                    <span class="text-sm text-muted">—</span>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    </Card>
  {/if}

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
      placeholder="เลขที่รายการ / ชื่อผู้ต้องขัง / ผู้ฝาก"
      class="ml-auto w-72 rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink"
    />
  </div>

  <Card padded={false}>
    <div class="overflow-x-auto">
      <table class="admin-table">
        <thead>
          <tr>
            <th>เลขที่รายการ</th>
            <th>ผู้ต้องขัง</th>
            <th>ผู้ฝาก</th>
            <th>ยอด</th>
            <th>สลิป</th>
            <th>สถานะ</th>
            <th>สร้างเมื่อ</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr>
              <td class="font-mono text-sm">{row.depositNo}</td>
              <td>
                <p class="font-medium text-ink">{row.inmateName}</p>
                <p class="text-sm text-muted">
                  {row.inmateCode}{row.zoneName ? ` · ${row.zoneName}` : ''}
                </p>
              </td>
              <td>
                <p class="text-ink">{row.depositorName}</p>
                <p class="text-sm text-muted">{formatPhone(row.customerPhone)}</p>
              </td>
              <td class="font-semibold text-ink">{formatBaht(row.amountSatang)}</td>
              <td class="text-sm text-muted">{row.paymentStatus ?? '—'}</td>
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
                {loading ? 'กำลังโหลด…' : 'ไม่มีรายการในกลุ่มนี้'}
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
    <button type="button" class="flex-1 cursor-default bg-black/30" aria-label="ปิด" onclick={() => (open = null)}
    ></button>
    <aside class="w-[28rem] max-w-full overflow-y-auto border-l border-line bg-surface p-5">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="font-mono text-sm text-muted">{open.depositNo}</p>
          <h2 class="text-xl font-semibold text-ink">{formatBaht(open.amountSatang)}</h2>
          <p class="text-sm text-muted">{STATUS_LABEL[open.status]}</p>
        </div>
        <Button size="sm" variant="ghost" onclick={() => (open = null)}>ปิด</Button>
      </div>

      <dl class="mt-4 space-y-2 border-t border-line pt-4 text-sm">
        <div class="flex justify-between gap-4">
          <dt class="text-muted">ผู้ต้องขัง</dt>
          <dd class="text-ink">{open.inmateName} ({open.inmateCode})</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">แดน</dt>
          <dd class="text-ink">{open.zoneName ?? '—'}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">ผู้ฝาก</dt>
          <dd class="text-ink">{open.depositorName}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">บัญชีญาติ</dt>
          <dd class="text-ink">{open.customerName} · {formatPhone(open.customerPhone)}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">บัตรฝากเงิน</dt>
          <dd class="font-mono text-ink">{open.cardNo ?? '—'}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">สถานะสลิป</dt>
          <dd class="text-ink">{open.paymentStatus ?? '—'}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">ได้รับเงินเมื่อ</dt>
          <dd class="text-ink">{formatDateTime(open.depositedAt)}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">โอนเข้าบัญชีเมื่อ</dt>
          <dd class="text-ink">{formatDateTime(open.completedAt)}</dd>
        </div>
        {#if open.reviewedByName}
          <div class="flex justify-between gap-4">
            <dt class="text-muted">ผู้ตรวจสอบ</dt>
            <dd class="text-ink">{open.reviewedByName}</dd>
          </div>
        {/if}
      </dl>

      {#if open.note}
        <p class="mt-3 rounded-xl bg-canvas px-3 py-2 text-sm text-ink">{open.note}</p>
      {/if}
      {#if open.rejectReason}
        <div class="mt-3"><Alert tone="danger" title={open.rejectReason} /></div>
      {/if}

      {#if open.payment}
        <div class="mt-4 border-t border-line pt-4">
          <p class="text-sm text-muted">
            การชำระเงิน {open.payment.paymentNo} · ยอดโอน {formatBaht(open.payment.chargeSatang)}
          </p>
          {#if open.payment.slipUrl}
            <a
              class="mt-2 inline-block text-sm text-brand-700 underline"
              href={api.admin.payments.slipUrl(open.payment.id)}
              target="_blank"
              rel="noreferrer"
            >
              ดูสลิปที่แนบไว้
            </a>
          {/if}
          <p class="mt-1 text-sm text-muted">
            ตรวจสอบสลิปทำที่หน้า “การชำระเงิน” — หน้านี้คือขั้นโอนเข้าบัญชีผู้ต้องขัง
          </p>
        </div>
      {/if}

      {#if canReview && (open.status === 'reviewing' || open.status === 'pending')}
        <div class="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
          {#if open.status === 'reviewing'}
            <Button loading={busyId === open.id} onclick={() => review(open!.id, 'completed')}>
              โอนเข้าบัญชีแล้ว
            </Button>
          {/if}
          <Button variant="ghost" onclick={() => review(open!.id, 'rejected')}>ปฏิเสธรายการ</Button>
        </div>
      {/if}
    </aside>
  </div>
{/if}
