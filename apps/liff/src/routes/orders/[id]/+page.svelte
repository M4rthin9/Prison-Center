<script lang="ts">
  import type { OrderDetail } from '@pc/contract'
  import { FULFILLMENT_STATUS_LABEL, PAYMENT_STATUS_LABEL } from '@pc/contract'
  import { Alert, Card, formatBaht, formatDateTime } from '@pc/ui'
  import { page } from '$app/state'
  import { api, toFormError } from '$lib/session.svelte.js'

  let order = $state<OrderDetail | null>(null)
  let loading = $state(true)
  let error = $state('')

  $effect(() => {
    const id = page.params.id!
    api.orders
      .get(id)
      .then((o) => (order = o))
      .catch((err) => (error = toFormError(err).message))
      .finally(() => (loading = false))
  })

  const STEPS = ['new', 'preparing', 'delivered'] as const
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <a class="text-sm text-brand-100" href="/orders">← ประวัติการสั่งซื้อ</a>
  <h1 class="mt-1 font-mono text-xl font-semibold">{order?.orderNo ?? '…'}</h1>
</header>

<main class="space-y-4 p-4 pb-24">
  {#if error}<Alert tone="danger" title={error} />{/if}
  {#if loading}
    <p class="py-8 text-center text-muted">กำลังโหลด…</p>
  {:else if order}
    {#if order.fulfillmentStatus === 'cancelled'}
      <Alert tone="danger" title="คำสั่งซื้อนี้ถูกยกเลิก">
        {order.cancelReason ?? 'เจ้าหน้าที่ยกเลิกคำสั่งซื้อนี้'}
      </Alert>
    {:else}
      {@const current = STEPS.indexOf(order.fulfillmentStatus as (typeof STEPS)[number])}
      <Card>
        <ol class="flex items-center justify-between">
          {#each STEPS as step, i (step)}
            {@const reached = current >= i}
            <li class="flex flex-1 flex-col items-center gap-1">
              <span
                class="flex size-8 items-center justify-center rounded-full text-sm
                       {reached ? 'bg-brand-600 text-white' : 'bg-line text-muted'}"
              >
                {i + 1}
              </span>
              <span class="text-xs {reached ? 'text-ink' : 'text-muted'}">
                {FULFILLMENT_STATUS_LABEL[step]}
              </span>
            </li>
          {/each}
        </ol>
      </Card>
    {/if}

    <Card title="ผู้รับสินค้า">
      <p class="font-medium text-ink">{order.inmateName}</p>
      <p class="text-sm text-muted">
        {order.inmateCode} · {order.prisonName}{order.zoneName ? ` · ${order.zoneName}` : ''}
      </p>
      <p class="mt-2 text-sm text-muted">ร้าน {order.shopName}</p>
      <p class="text-sm text-muted">สั่งเมื่อ {formatDateTime(order.orderedAt)}</p>
    </Card>

    <Card title="รายการสินค้า" padded={false}>
      <ul class="divide-y divide-line">
        {#each order.items as item (item.id)}
          <li class="flex items-start justify-between gap-3 px-5 py-3">
            <div class="min-w-0">
              <p class="text-ink">{item.name}</p>
              <p class="text-sm text-muted">
                {formatBaht(item.unitPriceSatang)} × {item.qty}
                {item.unit}
              </p>
            </div>
            <p class="shrink-0 font-medium text-ink">{formatBaht(item.lineTotalSatang)}</p>
          </li>
        {/each}
      </ul>
      <div class="space-y-1 border-t border-line px-5 py-4">
        <div class="flex justify-between text-sm text-muted">
          <span>ยอดสินค้า</span><span>{formatBaht(order.subtotalSatang)}</span>
        </div>
        {#if order.discountSatang > 0}
          <div class="flex justify-between text-sm text-muted">
            <span>ส่วนลด</span><span>-{formatBaht(order.discountSatang)}</span>
          </div>
        {/if}
        <div class="flex justify-between font-semibold text-ink">
          <span>ยอดรวม</span><span>{formatBaht(order.totalSatang)}</span>
        </div>
      </div>
    </Card>

    {#if order.note}
      <Card title="หมายเหตุ"><p class="text-sm text-ink">{order.note}</p></Card>
    {/if}

    <Card title="การชำระเงิน">
      <p class="text-ink">{PAYMENT_STATUS_LABEL[order.paymentStatus]}</p>
      {#if order.paymentStatus === 'paid'}
        <p class="mt-1 text-sm text-muted">ยืนยันเมื่อ {formatDateTime(order.paidAt)}</p>
      {:else if order.paymentStatus === 'awaiting_verify'}
        <p class="mt-1 text-sm text-muted">
          เจ้าหน้าที่กำลังตรวจสอบสลิปของคุณ ระบบจะแจ้งเตือนเมื่อตรวจสอบเสร็จ
        </p>
        <a class="mt-3 inline-block text-sm text-brand-700" href="/orders/{order.id}/pay">
          ดูสถานะ / แนบสลิปใหม่ →
        </a>
      {:else if order.fulfillmentStatus !== 'cancelled'}
        <a
          class="mt-3 inline-flex h-11 w-full items-center justify-center rounded-xl
                 bg-brand-600 font-medium text-white"
          href="/orders/{order.id}/pay"
        >
          ชำระเงินด้วย QR พร้อมเพย์
        </a>
      {/if}
    </Card>
  {/if}
</main>
