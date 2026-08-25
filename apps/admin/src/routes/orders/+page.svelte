<script lang="ts">
  import type { FulfillmentStatus, OrderSummary, ShopSummary } from '@pc/contract'
  import { FULFILLMENT_STATUS_LABEL, PAYMENT_STATUS_LABEL } from '@pc/contract'
  import { Alert, Button, Card, formatBaht, formatDateTime } from '@pc/ui'
  import { api, toFormError } from '$lib/session.svelte.js'

  let rows = $state<OrderSummary[]>([])
  let shops = $state<ShopSummary[]>([])
  let nextCursor = $state<string | null>(null)
  let status = $state<FulfillmentStatus | ''>('new')
  let shopId = $state('')
  let q = $state('')
  let loading = $state(true)
  let busyId = $state<string | null>(null)
  let message = $state('')
  let tone = $state<'danger' | 'success'>('success')

  const TABS = [
    { key: 'new', label: 'ใหม่' },
    { key: 'preparing', label: 'กำลังจัดเตรียม' },
    { key: 'delivered', label: 'ส่งมอบแล้ว' },
    { key: 'cancelled', label: 'ยกเลิก' },
    { key: '', label: 'ทั้งหมด' }
  ] as const

  $effect(() => {
    api.admin.shops
      .list({ includeInactive: true })
      .then((r) => (shops = r.items))
      .catch(() => (shops = []))
  })

  $effect(() => {
    const filters = { status, shopId, q: q.trim() }
    loading = true
    api.admin.orders
      .list({
        fulfillmentStatus: filters.status || undefined,
        shopId: filters.shopId || undefined,
        q: filters.q || undefined,
        limit: 25
      })
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
    const r = await api.admin.orders.list({
      fulfillmentStatus: status || undefined,
      shopId: shopId || undefined,
      q: q.trim() || undefined,
      cursor: nextCursor,
      limit: 25
    })
    rows = [...rows, ...r.items]
    nextCursor = r.nextCursor
  }

  async function advance(order: OrderSummary, next: FulfillmentStatus) {
    const reason =
      next === 'cancelled' ? (prompt(`เหตุผลที่ยกเลิก ${order.orderNo}`) ?? '').trim() : ''
    if (next === 'cancelled' && reason === '') return

    busyId = order.id
    try {
      const updated = await api.admin.orders.setFulfillment(order.id, {
        status: next,
        reason: reason || undefined
      })
      rows = rows.map((r) =>
        r.id === order.id ? { ...r, fulfillmentStatus: updated.fulfillmentStatus } : r
      )
      tone = 'success'
      message = `${order.orderNo} → ${FULFILLMENT_STATUS_LABEL[next]}`
    } catch (err) {
      tone = 'danger'
      message = toFormError(err).message
    } finally {
      busyId = null
    }
  }
</script>

<div class="space-y-5">
  <div>
    <h1 class="text-2xl font-semibold text-ink">คำสั่งซื้อ</h1>
    <p class="text-muted">รายการทั้งหมดในขอบเขตของคุณ เรียงจากใหม่ไปเก่า</p>
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

    <select
      bind:value={shopId}
      aria-label="กรองตามร้านค้า"
      class="ml-auto rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink"
    >
      <option value="">ทุกร้านค้า</option>
      {#each shops as shop (shop.id)}
        <option value={shop.id}>{shop.name}</option>
      {/each}
    </select>

    <input
      type="search"
      bind:value={q}
      placeholder="เลขคำสั่งซื้อ / ชื่อผู้ต้องขัง"
      class="w-64 rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink"
    />
  </div>

  <Card padded={false}>
    <div class="overflow-x-auto">
      <table class="admin-table">
        <thead>
          <tr>
            <th>เลขที่</th>
            <th>ผู้ต้องขัง</th>
            <th>ร้านค้า</th>
            <th>ชิ้น</th>
            <th>ยอดรวม</th>
            <th>ชำระเงิน</th>
            <th>สถานะ</th>
            <th>สั่งเมื่อ</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as order (order.id)}
            <tr>
              <td>
                <a class="font-mono text-sm text-brand-700" href="/orders/{order.id}">
                  {order.orderNo}
                </a>
              </td>
              <td>
                <p class="font-medium text-ink">{order.inmateName}</p>
                <p class="text-sm text-muted">
                  {order.inmateCode}{order.zoneName ? ` · ${order.zoneName}` : ''}
                </p>
              </td>
              <td>{order.shopName}</td>
              <td>{order.itemCount}</td>
              <td class="font-medium text-ink">{formatBaht(order.totalSatang)}</td>
              <td class="text-sm text-muted">{PAYMENT_STATUS_LABEL[order.paymentStatus]}</td>
              <td>{FULFILLMENT_STATUS_LABEL[order.fulfillmentStatus]}</td>
              <td class="text-muted">{formatDateTime(order.orderedAt)}</td>
              <td class="text-right whitespace-nowrap">
                {#if order.fulfillmentStatus === 'new'}
                  <Button
                    size="sm"
                    loading={busyId === order.id}
                    onclick={() => advance(order, 'preparing')}
                  >
                    เริ่มจัดเตรียม
                  </Button>
                  <Button size="sm" variant="ghost" onclick={() => advance(order, 'cancelled')}>
                    ยกเลิก
                  </Button>
                {:else if order.fulfillmentStatus === 'preparing'}
                  <Button
                    size="sm"
                    loading={busyId === order.id}
                    onclick={() => advance(order, 'delivered')}
                  >
                    ส่งมอบแล้ว
                  </Button>
                  <Button size="sm" variant="ghost" onclick={() => advance(order, 'cancelled')}>
                    ยกเลิก
                  </Button>
                {:else}
                  <span class="text-sm text-muted">—</span>
                {/if}
              </td>
            </tr>
          {:else}
            <tr>
              <td colspan="9" class="py-8 text-center text-muted">
                {loading ? 'กำลังโหลด…' : 'ไม่มีคำสั่งซื้อ'}
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
