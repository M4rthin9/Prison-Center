<script lang="ts">
  import type { LetterCredits, LetterPurchaseSummary } from '@pc/contract'
  import { Alert, Card, formatBaht, formatDateTime } from '@pc/ui'
  import { api, toFormError } from '$lib/session.svelte.js'

  const STATUS_LABEL: Record<LetterPurchaseSummary['status'], string> = {
    pending: 'รอชำระ / รอตรวจสลิป',
    paid: 'เติมสิทธิ์แล้ว',
    cancelled: 'ยกเลิก',
    refunded: 'คืนเงินแล้ว'
  }
  const REASON_LABEL: Record<string, string> = {
    purchase: 'ซื้อแพ็กเกจ',
    consume: 'ใช้ส่งจดหมาย',
    refund: 'คืนสิทธิ์',
    admin_adjust: 'เจ้าหน้าที่ปรับปรุง',
    expiry: 'หมดอายุ'
  }

  let purchases = $state<LetterPurchaseSummary[]>([])
  let credits = $state<LetterCredits | null>(null)
  let loading = $state(true)
  let error = $state('')

  $effect(() => {
    void (async () => {
      try {
        const [p, c] = await Promise.all([
          api.letters.purchases({ limit: 30 }),
          api.letters.credits()
        ])
        purchases = p.items
        credits = c
      } catch (err) {
        error = toFormError(err).message
      } finally {
        loading = false
      }
    })()
  })
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <a class="text-sm text-brand-100" href="/letters">← จดหมาย</a>
  <h1 class="mt-1 text-xl font-semibold">ประวัติการเติมสิทธิ์</h1>
</header>

<main class="space-y-4 p-4 pb-24">
  {#if error}<Alert tone="danger" title={error} />{/if}

  {#if credits}
    <Card title="สิทธิ์คงเหลือ">
      <div class="grid grid-cols-2 gap-3 text-center">
        <div class="rounded-xl bg-canvas py-3">
          <p class="text-2xl font-semibold text-ink">{credits.balance.toPrison}</p>
          <p class="text-sm text-muted">ส่งเข้าเรือนจำ</p>
        </div>
        <div class="rounded-xl bg-canvas py-3">
          <p class="text-2xl font-semibold text-ink">{credits.balance.toHome}</p>
          <p class="text-sm text-muted">ตอบกลับถึงบ้าน</p>
        </div>
      </div>
    </Card>
  {/if}

  <section class="space-y-2">
    <h2 class="px-1 text-sm font-medium text-muted">รายการซื้อ</h2>
    {#if loading}
      <p class="py-8 text-center text-muted">กำลังโหลด…</p>
    {:else if purchases.length === 0}
      <p class="py-8 text-center text-muted">ยังไม่มีรายการซื้อ</p>
    {:else}
      <ul class="space-y-2">
        {#each purchases as p (p.id)}
          <li>
            <a
              href="/letters/purchases/{p.id}"
              class="flex items-center justify-between gap-3 rounded-xl border border-line
                     bg-surface px-4 py-3"
            >
              <div>
                <p class="font-mono text-sm text-muted">{p.purchaseNo}</p>
                <p class="font-medium text-ink">{p.packageName}</p>
                <p class="text-sm text-muted">{formatDateTime(p.createdAt)}</p>
              </div>
              <div class="text-right">
                <p class="font-semibold text-ink">{formatBaht(p.priceSatang)}</p>
                <p class="text-sm text-muted">{STATUS_LABEL[p.status]}</p>
              </div>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  {#if credits && credits.ledger.length > 0}
    <Card title="ความเคลื่อนไหวของสิทธิ์" subtitle="ยอดคงเหลือคำนวณจากรายการเหล่านี้เสมอ">
      <ul class="divide-y divide-line text-sm">
        {#each credits.ledger as entry (entry.id)}
          <li class="flex items-center justify-between gap-3 py-2">
            <div>
              <p class="text-ink">{REASON_LABEL[entry.reason] ?? entry.reason}</p>
              <p class="text-muted">
                {entry.direction === 'to_prison' ? 'ส่งเข้าเรือนจำ' : 'ตอบกลับถึงบ้าน'} ·
                {formatDateTime(entry.createdAt)}
              </p>
            </div>
            <div class="text-right">
              <p class="font-medium {entry.delta > 0 ? 'text-ok' : 'text-ink'}">
                {entry.delta > 0 ? '+' : ''}{entry.delta}
              </p>
              <p class="text-muted">คงเหลือ {entry.balanceAfter}</p>
            </div>
          </li>
        {/each}
      </ul>
    </Card>
  {/if}
</main>
