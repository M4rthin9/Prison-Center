<script lang="ts">
  import type { PaymentChannelPublic, PaymentView } from '@pc/contract'
  import { PAYMENT_RAIL_LABEL, PAYMENT_STATE_LABEL } from '@pc/contract'
  import { Alert, Button, Card, formatBaht, formatDateTime } from '@pc/ui'
  import { api, toFormError } from '$lib/session.svelte.js'

  /**
   * The whole pay-by-slip experience, shared by orders and deposits: the
   * payment spine is one thing server-side (§4.3), so it is one component here.
   */
  interface Props {
    payment: PaymentView | null
    channels: PaymentChannelPublic[]
    busy?: boolean
    /** Asks the server for a QR. Omitting the channel takes the default. */
    request: (channelId?: string) => Promise<void>
    /** Called after a slip upload succeeds, with the refreshed payment. */
    onSlip?: (payment: PaymentView) => void
    /** Clears the local payment so the channel picker comes back. */
    reset?: () => void
  }

  let { payment = $bindable(), channels, busy = false, request, onSlip, reset }: Props = $props()

  let working = $state(false)
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
  const disabled = $derived(busy || working)

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
      onSlip?.(result.payment)
    } catch (err) {
      uploadError = toFormError(err).message
    } finally {
      working = false
      input.value = ''
    }
  }
</script>

{#if !payment || payment.status === 'expired' || payment.status === 'failed'}
  <Card title="เลือกช่องทางชำระเงิน">
    {#if channels.length === 0}
      <p class="text-sm text-muted">เรือนจำนี้ยังไม่ได้เปิดช่องทางชำระเงิน กรุณาติดต่อเจ้าหน้าที่</p>
    {:else}
      <ul class="space-y-2">
        {#each channels as channel (channel.id)}
          <li>
            <button
              class="w-full rounded-xl border border-line px-4 py-3 text-left transition
                     hover:border-brand-400 disabled:opacity-60"
              {disabled}
              onclick={() => request(channel.id)}
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
        {secondsLeft > 0 ? `QR หมดอายุใน ${countdown}` : 'QR หมดอายุแล้ว — กดขอ QR ใหม่ได้เลย'}
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
        {disabled}
        onchange={onSlipPicked}
        class="w-full rounded-xl border border-line bg-white px-3 py-2.5 text-sm text-ink
               file:mr-3 file:rounded-lg file:border-0 file:bg-brand-600 file:px-3 file:py-1.5
               file:text-white"
      />
    </label>
  </Card>

  {#if payment.status === 'pending' && channels.length > 1 && reset}
    <!-- Clearing the payment shows the picker again; choosing a different
         channel retires the old QR server-side. -->
    <Button variant="ghost" full {disabled} onclick={reset}>เปลี่ยนช่องทางชำระเงิน</Button>
  {/if}
{/if}
