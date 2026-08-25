<script lang="ts">
  import type { OrderDetail, PaymentChannelPublic, PaymentView } from '@pc/contract'
  import { PAYMENT_RAIL_LABEL, PAYMENT_STATE_LABEL } from '@pc/contract'
  import { Alert, Button, Card, formatBaht, formatDateTime } from '@pc/ui'
  import { page } from '$app/state'
  import { api, toFormError } from '$lib/session.svelte.js'

  let order = $state<OrderDetail | null>(null)
  let channels = $state<PaymentChannelPublic[]>([])
  let payment = $state<PaymentView | null>(null)
  let loading = $state(true)
  let working = $state(false)
  let error = $state('')
  let uploadError = $state('')
  let copied = $state(false)

  /** Ticks once a second so the countdown is live, not a value from page load. */
  let clock = $state(Date.now())
  $effect(() => {
    const t = setInterval(() => (clock = Date.now()), 1000)
    return () => clearInterval(t)
  })

  const secondsLeft = $derived(
    payment?.expiresAt && payment.status === 'pending'
      ? Math.max(0, Math.floor((payment.expiresAt - clock) / 1000))
      : null
  )
  const countdown = $derived(
    secondsLeft === null
      ? ''
      : `${String(Math.floor(secondsLeft / 60)).padStart(2, '0')}:${String(secondsLeft % 60).padStart(2, '0')}`
  )
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

  async function copyAmount() {
    if (!payment) return
    await navigator.clipboard?.writeText((payment.chargeSatang / 100).toFixed(2))
    copied = true
    setTimeout(() => (copied = false), 2000)
  }

  async function onSlipPicked(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    if (!file || !payment) return
    working = true
    uploadError = ''
    try {
      const result = await api.payments.uploadSlip(payment.id, file, file.name)
      payment = result.payment
      if (order) order = await api.orders.get(order.id)
    } catch (err) {
      uploadError = toFormError(err).message
    } finally {
      working = false
      input.value = ''
    }
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
      {#if !payment || payment.status === 'expired' || payment.status === 'failed'}
        <Card title="เลือกช่องทางชำระเงิน">
          {#if channels.length === 0}
            <p class="text-sm text-muted">
              เรือนจำนี้ยังไม่ได้เปิดช่องทางชำระเงิน กรุณาติดต่อเจ้าหน้าที่
            </p>
          {:else}
            <ul class="space-y-2">
              {#each channels as channel (channel.id)}
                <li>
                  <button
                    class="w-full rounded-xl border border-line px-4 py-3 text-left transition
                         hover:border-brand-400 disabled:opacity-60"
                    disabled={working}
                    onclick={() => requestQr(channel.id)}
                  >
                    <span class="block font-medium text-ink">{channel.displayName}</span>
                    <span class="block text-sm text-muted">{PAYMENT_RAIL_LABEL[channel.rail]}</span>
                    {#if channel.note}
                      <span class="mt-1 block text-sm text-muted">{channel.note}</span>
                    {/if}
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </Card>
      {:else}
        <Card title={payment.channelName} subtitle={PAYMENT_RAIL_LABEL[payment.rail]}>
          {#if payment.qrImage}
            <div class="flex flex-col items-center gap-3">
              <img
                src={payment.qrImage}
                alt="QR พร้อมเพย์สำหรับชำระเงิน {chargeText}"
                class="size-64 rounded-xl border border-line bg-white"
              />
              <p class="text-center text-sm text-muted">
                เปิดแอปธนาคาร → สแกน QR → ตรวจสอบยอดให้ตรงทุกสตางค์
              </p>
            </div>
          {:else if payment.accountNo}
            <dl class="space-y-2 text-sm">
              <div class="flex justify-between gap-4">
                <dt class="text-muted">ธนาคาร</dt>
                <dd class="text-ink">{payment.bankName ?? payment.bankCode}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="text-muted">เลขบัญชี</dt>
                <dd class="font-mono text-ink">{payment.accountNo}</dd>
              </div>
              <div class="flex justify-between gap-4">
                <dt class="text-muted">ชื่อบัญชี</dt>
                <dd class="text-ink">{payment.accountName}</dd>
              </div>
            </dl>
          {/if}

          <div class="mt-4 flex items-center justify-between gap-3 border-t border-line pt-4">
            <div>
              <p class="text-sm text-muted">ยอดโอน</p>
              <p class="text-lg font-semibold text-ink">{chargeText}</p>
            </div>
            <Button variant="secondary" size="sm" onclick={copyAmount}>
              {copied ? 'คัดลอกแล้ว' : 'คัดลอกยอด'}
            </Button>
          </div>

          {#if payment.qrRef1}
            <p class="mt-3 text-sm text-muted">
              Ref1 <span class="font-mono text-ink">{payment.qrRef1}</span>
              {#if payment.qrRef2}
                · Ref2 <span class="font-mono text-ink">{payment.qrRef2}</span>
              {/if}
            </p>
          {/if}

          {#if secondsLeft !== null}
            <p class="mt-3 text-sm {secondsLeft < 300 ? 'text-danger' : 'text-muted'}">
              {secondsLeft > 0
                ? `QR หมดอายุใน ${countdown}`
                : 'QR หมดอายุแล้ว — กดขอ QR ใหม่ได้เลย'}
            </p>
          {/if}

          <p class="mt-1 text-sm text-muted">เลขที่รายการ {payment.paymentNo}</p>
        </Card>

        <Card title="แนบสลิปโอนเงิน">
          {#if uploadError}<div class="mb-3"><Alert tone="danger" title={uploadError} /></div>{/if}
          {#if payment.status === 'awaiting_verify'}
            <p class="text-sm text-ink">
              ส่งสลิปแล้วเมื่อ {formatDateTime(payment.slipUploadedAt)} — สถานะ
              {PAYMENT_STATE_LABEL[payment.status]}
            </p>
            <p class="mt-1 text-sm text-muted">แนบใหม่ได้หากภาพไม่ชัด</p>
          {:else}
            <p class="text-sm text-muted">
              ถ่ายภาพสลิปให้เห็น QR เล็กมุมล่างของสลิป ระบบจะอ่านเลขอ้างอิงให้อัตโนมัติ
            </p>
          {/if}
          <label class="mt-3 block">
            <span class="sr-only">เลือกไฟล์สลิป</span>
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp"
              disabled={working}
              onchange={onSlipPicked}
              class="w-full rounded-xl border border-line bg-white px-3 py-2.5 text-sm text-ink
                   file:mr-3 file:rounded-lg file:border-0 file:bg-brand-600 file:px-3 file:py-1.5
                   file:text-white"
            />
          </label>
        </Card>

        {#if payment.status === 'pending' && channels.length > 1}
          <!-- Clearing the payment shows the picker again; choosing a different
               channel retires the old QR server-side. -->
          <Button variant="ghost" full disabled={working} onclick={() => (payment = null)}>
            เปลี่ยนช่องทางชำระเงิน
          </Button>
        {/if}
      {/if}
    {/if}
  {/if}
</main>
