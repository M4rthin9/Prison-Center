<script lang="ts">
  import type { DepositDetail, DepositStatus, PaymentChannelPublic } from '@pc/contract'
  import { Alert, Button, Card, formatBaht, formatDateTime } from '@pc/ui'
  import { page } from '$app/state'
  import PaymentPanel from '$lib/PaymentPanel.svelte'
  import { api, toFormError } from '$lib/session.svelte.js'

  const STATUS_LABEL: Record<DepositStatus, string> = {
    pending: 'รอชำระเงิน',
    reviewing: 'กำลังตรวจสอบ',
    completed: 'เสร็จสิ้น',
    rejected: 'ไม่สำเร็จ',
    cancelled: 'ยกเลิกแล้ว'
  }

  let deposit = $state<DepositDetail | null>(null)
  let channels = $state<PaymentChannelPublic[]>([])
  let payment = $state<DepositDetail['payment']>(null)
  let loading = $state(true)
  let working = $state(false)
  let error = $state('')

  const chargeText = $derived(payment ? formatBaht(payment.chargeSatang) : '')
  const canPay = $derived(deposit?.status === 'pending')

  async function load() {
    loading = true
    try {
      const d = await api.deposits.get(page.params.id!)
      deposit = d
      payment = d.payment
      channels = (
        await api.payments.channels({ prisonId: d.prisonId, purpose: 'deposit' })
      ).items
    } catch (err) {
      error = toFormError(err).message
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void load()
  })

  /** A fresh QR for this same deposit — the number and amount never change. */
  async function requestQr(channelId?: string) {
    if (!deposit) return
    working = true
    error = ''
    try {
      deposit = await api.deposits.pay(deposit.id, channelId ? { channelId } : {})
      payment = deposit.payment
    } catch (err) {
      error = toFormError(err).message
    } finally {
      working = false
    }
  }

  async function cancel() {
    if (!deposit) return
    working = true
    try {
      deposit = await api.deposits.cancel(deposit.id)
      payment = deposit.payment
    } catch (err) {
      error = toFormError(err).message
    } finally {
      working = false
    }
  }
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <a class="text-sm text-brand-100" href="/deposits">← การฝากเงิน</a>
  <h1 class="mt-1 text-xl font-semibold">รายละเอียดการฝากเงิน</h1>
  {#if deposit}<p class="font-mono text-sm text-brand-100">{deposit.depositNo}</p>{/if}
</header>

<main class="space-y-4 p-4 pb-24">
  {#if error}<Alert tone="danger" title={error} />{/if}

  {#if loading}
    <p class="py-8 text-center text-muted">กำลังโหลด…</p>
  {:else if deposit}
    <Card>
      <div class="flex items-baseline justify-between">
        <span class="text-muted">ยอดฝาก</span>
        <span class="text-2xl font-semibold text-ink">{formatBaht(deposit.amountSatang)}</span>
      </div>
      <dl class="mt-3 space-y-2 border-t border-line pt-3 text-sm">
        <div class="flex justify-between gap-4">
          <dt class="text-muted">ผู้ต้องขัง</dt>
          <dd class="text-ink">{deposit.inmateName} ({deposit.inmateCode})</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">เรือนจำ / แดน</dt>
          <dd class="text-ink">
            {deposit.prisonName}{deposit.zoneName ? ` · ${deposit.zoneName}` : ''}
          </dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">ผู้ฝาก</dt>
          <dd class="text-ink">{deposit.depositorName}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">สถานะ</dt>
          <dd class="text-ink">{STATUS_LABEL[deposit.status]}</dd>
        </div>
      </dl>
      {#if payment && payment.amountSaltSatang > 0 && canPay}
        <p class="mt-3 text-sm text-warn">
          กรุณาโอน <strong>{chargeText}</strong> ให้ตรงทุกสตางค์ — เศษสตางค์ท้ายยอดคือรหัสอ้างอิงของรายการนี้
        </p>
      {/if}
    </Card>

    {#if deposit.status === 'completed'}
      <Alert tone="success" title="โอนเข้าบัญชีผู้ต้องขังแล้ว">
        เจ้าหน้าที่ดำเนินการเมื่อ {formatDateTime(deposit.completedAt)}
      </Alert>
    {:else if deposit.status === 'reviewing'}
      <Alert tone="info" title="ได้รับเงินแล้ว กำลังนำเข้าบัญชีผู้ต้องขัง">
        ตรวจสอบสลิปเรียบร้อยเมื่อ {formatDateTime(deposit.depositedAt)} — ระบบจะแจ้งเตือนเมื่อเสร็จสิ้น
      </Alert>
    {:else if deposit.status === 'rejected'}
      <Alert tone="danger" title="รายการนี้ไม่สำเร็จ">
        {deposit.rejectReason ?? 'กรุณาติดต่อเจ้าหน้าที่'}
      </Alert>
    {:else if deposit.status === 'cancelled'}
      <Alert tone="info" title="ยกเลิกรายการแล้ว" />
    {:else if deposit.rejectReason}
      <Alert tone="danger" title="สลิปก่อนหน้าไม่ผ่านการตรวจสอบ">{deposit.rejectReason}</Alert>
    {/if}

    {#if canPay}
      <PaymentPanel
        bind:payment
        {channels}
        busy={working}
        request={requestQr}
        onSlip={load}
        reset={() => (payment = null)}
      />

      {#if payment?.status !== 'awaiting_verify'}
        <Button variant="ghost" full loading={working} onclick={cancel}>ยกเลิกรายการฝากเงินนี้</Button>
      {/if}
    {/if}
  {/if}
</main>
