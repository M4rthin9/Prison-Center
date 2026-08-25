<script lang="ts">
  import type { OrderSummary } from '@pc/contract'
  import { FULFILLMENT_STATUS_LABEL, PAYMENT_STATUS_LABEL } from '@pc/contract'
  import { Alert, formatBaht, formatDateTime } from '@pc/ui'
  import { api, toFormError } from '$lib/session.svelte.js'

  let orders = $state<OrderSummary[]>([])
  let nextCursor = $state<string | null>(null)
  let loading = $state(true)
  let loadingMore = $state(false)
  let error = $state('')

  $effect(() => {
    api.orders
      .list({ limit: 20 })
      .then((r) => {
        orders = r.items
        nextCursor = r.nextCursor
      })
      .catch((err) => (error = toFormError(err).message))
      .finally(() => (loading = false))
  })

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    loadingMore = true
    try {
      const r = await api.orders.list({ cursor: nextCursor, limit: 20 })
      orders = [...orders, ...r.items]
      nextCursor = r.nextCursor
    } catch (err) {
      error = toFormError(err).message
    } finally {
      loadingMore = false
    }
  }

  const tone = (status: OrderSummary['fulfillmentStatus']) =>
    status === 'delivered'
      ? 'bg-ok/15 text-ink'
      : status === 'cancelled'
        ? 'bg-danger/10 text-ink'
        : 'bg-brand-50 text-brand-800'
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <h1 class="text-xl font-semibold">ประวัติการสั่งซื้อ</h1>
</header>

<main class="space-y-3 p-4 pb-24">
  {#if error}<Alert tone="danger" title={error} />{/if}

  {#if loading}
    <p class="py-8 text-center text-muted">กำลังโหลด…</p>
  {:else if orders.length === 0}
    <Alert tone="info" title="ยังไม่มีคำสั่งซื้อ">
      <a class="text-brand-700 underline" href="/shop">เริ่มเลือกซื้อสินค้า</a>
    </Alert>
  {:else}
    <ul class="space-y-3">
      {#each orders as order (order.id)}
        <li>
          <a
            href="/orders/{order.id}"
            class="block rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-sm"
          >
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="font-mono text-sm text-muted">{order.orderNo}</p>
                <p class="font-medium text-ink">{order.shopName}</p>
                <p class="text-sm text-muted">
                  ถึง {order.inmateName}{order.zoneName ? ` · ${order.zoneName}` : ''}
                </p>
              </div>
              <div class="shrink-0 text-right">
                <p class="font-semibold text-ink">{formatBaht(order.totalSatang)}</p>
                <p class="text-sm text-muted">{order.itemCount} ชิ้น</p>
              </div>
            </div>
            <div class="mt-3 flex items-center gap-2 text-xs">
              <span class="rounded-full px-2.5 py-0.5 {tone(order.fulfillmentStatus)}">
                {FULFILLMENT_STATUS_LABEL[order.fulfillmentStatus]}
              </span>
              <span class="rounded-full bg-line px-2.5 py-0.5 text-muted">
                {PAYMENT_STATUS_LABEL[order.paymentStatus]}
              </span>
              <span class="ml-auto text-muted">{formatDateTime(order.orderedAt)}</span>
            </div>
          </a>
        </li>
      {/each}
    </ul>

    {#if nextCursor}
      <button
        type="button"
        onclick={loadMore}
        disabled={loadingMore}
        class="w-full rounded-xl border border-line bg-surface py-3 text-sm text-ink"
      >
        {loadingMore ? 'กำลังโหลด…' : 'ดูเพิ่มเติม'}
      </button>
    {/if}
  {/if}
</main>
