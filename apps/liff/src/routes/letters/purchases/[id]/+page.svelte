<script lang="ts">
  import type { LetterPurchaseDetail, PaymentChannelPublic } from '@pc/contract'
  import { Alert, Card, formatBaht, formatDateTime } from '@pc/ui'
  import { page } from '$app/state'
  import PaymentPanel from '$lib/PaymentPanel.svelte'
  import { api, toFormError } from '$lib/session.svelte.js'

  let purchase = $state<LetterPurchaseDetail | null>(null)
  let channels = $state<PaymentChannelPublic[]>([])
  let payment = $state<LetterPurchaseDetail['payment']>(null)
  let loading = $state(true)
  let working = $state(false)
  let error = $state('')

  const canPay = $derived(purchase?.status === 'pending')

  async function load() {
    loading = true
    try {
      const p = await api.letters.purchaseGet(page.params.id!)
      purchase = p
      payment = p.payment
      channels = (await api.payments.channels({ prisonId: p.prisonId, purpose: 'letter_package' }))
        .items
    } catch (err) {
      error = toFormError(err).message
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void load()
  })

  /** A fresh QR for the same purchase — never a second purchase. */
  async function requestQr(channelId?: string) {
    if (!purchase) return
    working = true
    error = ''
    try {
      purchase = await api.letters.purchasePay(purchase.id, channelId ? { channelId } : {})
      payment = purchase.payment
    } catch (err) {
      error = toFormError(err).message
    } finally {
      working = false
    }
  }
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <a class="text-sm text-brand-100" href="/letters">← จดหมาย</a>
  <h1 class="mt-1 text-xl font-semibold">ชำระค่าแพ็กเกจจดหมาย</h1>
  {#if purchase}<p class="font-mono text-sm text-brand-100">{purchase.purchaseNo}</p>{/if}
</header>

<main class="space-y-4 p-4 pb-24">
  {#if error}<Alert tone="danger" title={error} />{/if}

  {#if loading}
    <p class="py-8 text-center text-muted">กำลังโหลด…</p>
  {:else if purchase}
    <Card>
      <div class="flex items-baseline justify-between">
        <span class="text-muted">{purchase.packageName}</span>
        <span class="text-2xl font-semibold text-ink">{formatBaht(purchase.priceSatang)}</span>
      </div>
      <dl class="mt-3 space-y-2 border-t border-line pt-3 text-sm">
        <div class="flex justify-between gap-4">
          <dt class="text-muted">สิทธิ์ที่จะได้รับ</dt>
          <dd class="text-ink">
            {purchase.quota} ฉบับ ·
            {purchase.direction === 'to_prison' ? 'ส่งเข้าเรือนจำ' : 'ตอบกลับถึงบ้าน'}
          </dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">เรือนจำ</dt>
          <dd class="text-ink">{purchase.prisonName}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">ซื้อเมื่อ</dt>
          <dd class="text-ink">{formatDateTime(purchase.createdAt)}</dd>
        </div>
      </dl>
    </Card>

    {#if purchase.status === 'paid'}
      <Alert tone="success" title="เติมสิทธิ์เรียบร้อยแล้ว">
        เจ้าหน้าที่ตรวจสลิปผ่านเมื่อ {formatDateTime(purchase.paidAt)} — เพิ่มให้ {purchase.quota} ฉบับ
        <span class="mt-3 block">
          <a class="text-brand-700 underline" href="/letters">กลับไปเขียนจดหมาย →</a>
        </span>
      </Alert>
    {:else if purchase.status === 'refunded'}
      <Alert tone="danger" title="คืนเงินรายการนี้แล้ว" />
    {:else if purchase.status === 'cancelled'}
      <Alert tone="info" title="ยกเลิกรายการแล้ว" />
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
      <Alert tone="info" title="สิทธิ์จะเข้าบัญชีหลังเจ้าหน้าที่ตรวจสลิป">
        ระบบจะแจ้งเตือนเมื่อตรวจเสร็จ — โดยปกติภายในเวลาทำการ
      </Alert>
    {/if}
  {/if}
</main>
