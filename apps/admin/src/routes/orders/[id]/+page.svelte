<script lang="ts">
  import type { FulfillmentStatus, OrderDetail } from '@pc/contract'
  import { FULFILLMENT_STATUS_LABEL, PAYMENT_STATUS_LABEL } from '@pc/contract'
  import { Alert, Button, Card, formatBaht, formatDateTime, formatPhone } from '@pc/ui'
  import { page } from '$app/state'
  import { api, toFormError } from '$lib/session.svelte.js'

  let order = $state<OrderDetail | null>(null)
  let loading = $state(true)
  let busy = $state(false)
  let message = $state('')
  let tone = $state<'danger' | 'success'>('success')

  async function load() {
    loading = true
    try {
      order = await api.admin.orders.get(page.params.id!)
    } catch (err) {
      tone = 'danger'
      message = toFormError(err).message
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void page.params.id
    void load()
  })

  async function advance(next: FulfillmentStatus) {
    if (!order) return
    const reason =
      next === 'cancelled' ? (prompt(`เหตุผลที่ยกเลิก ${order.orderNo}`) ?? '').trim() : ''
    if (next === 'cancelled' && reason === '') return

    busy = true
    message = ''
    try {
      order = await api.admin.orders.setFulfillment(order.id, {
        status: next,
        reason: reason || undefined
      })
      tone = 'success'
      message = `อัปเดตเป็น "${FULFILLMENT_STATUS_LABEL[next]}" แล้ว`
    } catch (err) {
      tone = 'danger'
      message = toFormError(err).message
    } finally {
      busy = false
    }
  }
</script>

<div class="space-y-5">
  <div>
    <a class="text-sm text-brand-700" href="/orders">← คำสั่งซื้อทั้งหมด</a>
    <h1 class="font-mono text-2xl font-semibold text-ink">{order?.orderNo ?? '…'}</h1>
  </div>

  {#if message}<Alert {tone} title={message} />{/if}

  {#if loading}
    <p class="py-8 text-center text-muted">กำลังโหลด…</p>
  {:else if order}
    <div class="grid gap-5 lg:grid-cols-3">
      <div class="space-y-5 lg:col-span-2">
        <Card title="รายการสินค้า" padded={false}>
          <div class="overflow-x-auto">
            <table class="admin-table">
              <thead>
                <tr>
                  <th>SKU</th>
                  <th>สินค้า</th>
                  <th>หมวดหมู่</th>
                  <th>ราคา/หน่วย</th>
                  <th>จำนวน</th>
                  <th>รวม</th>
                </tr>
              </thead>
              <tbody>
                {#each order.items as item (item.id)}
                  <tr>
                    <td class="font-mono text-sm">{item.sku}</td>
                    <td class="text-ink">{item.name}</td>
                    <td>{item.categoryName ?? '—'}</td>
                    <td>{formatBaht(item.unitPriceSatang)}</td>
                    <td>{item.qty} {item.unit}</td>
                    <td class="font-medium text-ink">{formatBaht(item.lineTotalSatang)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <div class="space-y-1 border-t border-line px-5 py-4">
            <div class="flex justify-between text-sm text-muted">
              <span>ยอดสินค้า</span><span>{formatBaht(order.subtotalSatang)}</span>
            </div>
            <div class="flex justify-between text-lg font-semibold text-ink">
              <span>ยอดรวม</span><span>{formatBaht(order.totalSatang)}</span>
            </div>
          </div>
        </Card>

        {#if order.note}
          <Card title="หมายเหตุจากญาติ"><p class="text-ink">{order.note}</p></Card>
        {/if}
        {#if order.cancelReason}
          <Card title="เหตุผลที่ยกเลิก"><p class="text-ink">{order.cancelReason}</p></Card>
        {/if}
      </div>

      <div class="space-y-5">
        <Card title="สถานะ">
          <p class="text-ink">{FULFILLMENT_STATUS_LABEL[order.fulfillmentStatus]}</p>
          <p class="text-sm text-muted">{PAYMENT_STATUS_LABEL[order.paymentStatus]}</p>
          <div class="mt-4 flex flex-wrap gap-2">
            {#if order.fulfillmentStatus === 'new'}
              <Button loading={busy} onclick={() => advance('preparing')}>เริ่มจัดเตรียม</Button>
            {:else if order.fulfillmentStatus === 'preparing'}
              <Button loading={busy} onclick={() => advance('delivered')}>ส่งมอบแล้ว</Button>
            {/if}
            {#if order.fulfillmentStatus === 'new' || order.fulfillmentStatus === 'preparing'}
              <Button variant="ghost" onclick={() => advance('cancelled')}>ยกเลิก</Button>
            {/if}
          </div>
        </Card>

        <Card title="ผู้ต้องขัง">
          <p class="font-medium text-ink">{order.inmateName}</p>
          <p class="text-sm text-muted">
            {order.inmateCode} · {order.prisonName}{order.zoneName ? ` · ${order.zoneName}` : ''}
          </p>
          <p class="mt-2 text-sm text-muted">ร้าน {order.shopName}</p>
        </Card>

        <Card title="ญาติผู้สั่งซื้อ">
          <p class="font-medium text-ink">{order.customerName}</p>
          <p class="text-sm text-muted">{formatPhone(order.customerPhone)}</p>
          <p class="mt-2 text-sm text-muted">สั่งเมื่อ {formatDateTime(order.orderedAt)}</p>
          {#if order.fulfilledAt}
            <p class="text-sm text-muted">ส่งมอบ {formatDateTime(order.fulfilledAt)}</p>
          {/if}
          {#if order.cancelledAt}
            <p class="text-sm text-muted">ยกเลิก {formatDateTime(order.cancelledAt)}</p>
          {/if}
        </Card>
      </div>
    </div>
  {/if}
</div>
