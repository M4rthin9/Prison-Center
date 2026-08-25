<script lang="ts">
  import type { OrderDetail, PaymentChannelPublic, PaymentView } from '@pc/contract'
  import { Alert, Card, formatBaht, formatDateTime } from '@pc/ui'
  import { page } from '$app/state'
  import PaymentPanel from '$lib/PaymentPanel.svelte'
  import { api, toFormError } from '$lib/session.svelte.js'

  let order = $state<OrderDetail | null>(null)
  let channels = $state<PaymentChannelPublic[]>([])
  let payment = $state<PaymentView | null>(null)
  let loading = $state(true)
  let working = $state(false)
  let error = $state('')

  /** The satang tail is the reference number on tag-29. Never let it round. */
  const chargeText = $derived(payment ? formatBaht(payment.chargeSatang) : '')

  $effect(() => {
    const id = page.params.id!
    loading = true
    api.orders
      .get(id)
      .then(async (o) => {
        order = o
        const [chans, existing] = await Promise.all([
          api.payments.channels({ prisonId: o.prisonId, purpose: 'order' }),
          o.paymentStatus === 'unpaid'
            ? Promise.resolve(null)
            : api.payments.list({ limit: 20 }).then((p) => p.items.find((x) => x.purposeId === id))
        ])
        channels = chans.items
        if (existing) payment = existing
      })
      .catch((err) => (error = toFormError(err).message))
      .finally(() => (loading = false))
  })

  async function requestQr(channelId?: string) {
    if (!order) return
    working = true
    error = ''
    try {
      payment = await api.orders.pay(order.id, channelId ? { channelId } : {})
    } catch (err) {
      error = toFormError(err).message
    } finally {
      working = false
    }
  }

  async function afterSlip() {
    if (order) order = await api.orders.get(order.id)
  }

  const canPay = $derived(
    order !== null &&
      order.fulfillmentStatus !== 'cancelled' &&
      ['unpaid', 'failed', 'expired'].includes(order.paymentStatus)
  )
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <a class="text-sm text-brand-100" href="/orders/{page.params.id}">← รายละเอียดคำสั่งซื้อ</a>
  <h1 class="mt-1 text-xl font-semibold">ชำระเงิน</h1>
  {#if order}<p class="font-mono text-sm text-brand-100">{order.orderNo}</p>{/if}
</header>

<main class="space-y-4 p-4 pb-24">
  {#if error}<Alert tone="danger" title={error} />{/if}

  {#if loading}
    <p class="py-8 text-center text-muted">กำลังโหลด…</p>
  {:else if order}
    <Card>
      <div class="flex items-baseline justify-between">
        <span class="text-muted">ยอดที่ต้องชำระ</span>
        <span class="text-2xl font-semibold text-ink">
          {formatBaht(payment?.chargeSatang ?? order.totalSatang)}
        </span>
      </div>
      {#if payment && payment.amountSaltSatang > 0}
        <p class="mt-2 text-sm text-warn">
          กรุณาโอน <strong>{chargeText}</strong> ให้ตรงทุกสตางค์ — เศษสตางค์ท้ายยอดคือรหัสอ้างอิงที่ใช้จับคู่การชำระเงินของคุณ
        </p>
      {/if}
    </Card>

    {#if order.paymentStatus === 'paid'}
      <Alert tone="success" title="ชำระเงินเรียบร้อยแล้ว">
        เจ้าหน้าที่ยืนยันการชำระเงินของคุณแล้ว เมื่อ {formatDateTime(order.paidAt)}
      </Alert>
    {:else if order.paymentStatus === 'awaiting_verify'}
      <Alert tone="info" title="รอเจ้าหน้าที่ตรวจสอบสลิป">
        โดยปกติใช้เวลาไม่เกิน 1 วันทำการ ระบบจะแจ้งเตือนเมื่อตรวจสอบเสร็จ
      </Alert>
    {:else if payment?.rejectReason}
      <Alert tone="danger" title="สลิปก่อนหน้าไม่ผ่านการตรวจสอบ">{payment.rejectReason}</Alert>
    {/if}

    {#if canPay || order.paymentStatus === 'awaiting_verify'}
      <PaymentPanel
        bind:payment
        {channels}
        busy={working}
        request={requestQr}
        onSlip={afterSlip}
        reset={() => (payment = null)}
      />
    {/if}
  {/if}
</main>
