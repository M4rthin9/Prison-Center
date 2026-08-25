<script lang="ts">
  import type { DepositCard, DepositStatus, DepositSummary, PublicSettings } from '@pc/contract'
  import { Alert, Button, Card, formatBaht, formatDateTime } from '@pc/ui'
  import { goto } from '$app/navigation'
  import { api, session, toFormError } from '$lib/session.svelte.js'

  const STATUS_LABEL: Record<DepositStatus, string> = {
    pending: 'รอชำระเงิน',
    reviewing: 'กำลังตรวจสอบ',
    completed: 'เสร็จสิ้น',
    rejected: 'ไม่สำเร็จ',
    cancelled: 'ยกเลิกแล้ว'
  }
  const STATUS_TONE: Record<DepositStatus, string> = {
    pending: 'bg-warn/15 text-ink',
    reviewing: 'bg-brand-50 text-brand-800',
    completed: 'bg-ok/15 text-ink',
    rejected: 'bg-danger/10 text-danger',
    cancelled: 'bg-canvas text-muted'
  }
  const CARD_LABEL: Record<DepositCard['status'], string> = {
    pending: 'รอเจ้าหน้าที่อนุมัติ',
    approved: 'ใช้งานได้',
    rejected: 'ไม่อนุมัติ',
    suspended: 'ถูกระงับ'
  }

  let cards = $state<DepositCard[]>([])
  let deposits = $state<DepositSummary[]>([])
  let settings = $state<PublicSettings | null>(null)
  let loading = $state(true)
  let working = $state(false)
  let error = $state('')

  let inmateId = $state('')
  let amountBaht = $state('')
  let depositorName = $state('')

  const inmates = $derived(session.verifiedInmates)
  const cardFor = (id: string) => cards.find((c) => c.inmateId === id)
  const selectedCard = $derived(inmateId ? cardFor(inmateId) : undefined)
  const requireCard = $derived(settings?.deposit?.requireCard ?? true)
  const canDeposit = $derived(
    !!inmateId && (!requireCard || selectedCard?.status === 'approved')
  )
  const amountSatang = $derived(Math.round(Number(amountBaht.replace(/,/g, '')) * 100) || 0)

  async function load() {
    loading = true
    try {
      const [c, d, s] = await Promise.all([
        api.deposits.cards(),
        api.deposits.list({ limit: 20 }),
        api.settings.public()
      ])
      cards = c.items
      deposits = d.items
      settings = s
      inmateId ||= inmates[0]?.inmateId ?? ''
      depositorName ||= session.me?.fullName ?? ''
    } catch (err) {
      error = toFormError(err).message
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void load()
  })

  async function requestCard(id: string) {
    working = true
    error = ''
    try {
      await api.deposits.requestCard({ inmateId: id })
      await load()
    } catch (err) {
      error = toFormError(err).message
    } finally {
      working = false
    }
  }

  async function submit(event: SubmitEvent) {
    event.preventDefault()
    working = true
    error = ''
    try {
      const deposit = await api.deposits.create({
        inmateId,
        amountSatang,
        depositorName: depositorName.trim() || undefined
      })
      await goto(`/deposits/${deposit.id}`)
    } catch (err) {
      error = toFormError(err).message
    } finally {
      working = false
    }
  }
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <h1 class="text-xl font-semibold">การฝากเงิน</h1>
  <p class="text-sm text-brand-100">ฝากเงินเข้าบัญชีผู้ต้องขังผ่านพร้อมเพย์</p>
</header>

<main class="space-y-4 p-4 pb-24">
  {#if error}<Alert tone="danger" title={error} />{/if}

  {#if !session.canTransact}
    <Alert tone="warning" title="ยังฝากเงินไม่ได้">
      บัญชีของคุณต้องได้รับการยืนยันความสัมพันธ์กับผู้ต้องขังจากเจ้าหน้าที่ก่อน
    </Alert>
  {:else}
    <Card title="บัตรฝากเงิน" subtitle="ลงทะเบียนครั้งเดียวต่อผู้ต้องขังหนึ่งราย">
      <ul class="space-y-3">
        {#each inmates as inmate (inmate.inmateId)}
          {@const card = cardFor(inmate.inmateId)}
          <li class="flex items-center justify-between gap-3">
            <div>
              <p class="font-medium text-ink">{inmate.fullName}</p>
              <p class="text-sm text-muted">
                {inmate.inmateCode}{inmate.zoneName ? ` · ${inmate.zoneName}` : ''}
              </p>
              {#if card}
                <p class="text-sm text-muted">
                  {CARD_LABEL[card.status]}{card.cardNo ? ` · ${card.cardNo}` : ''}
                </p>
                {#if card.rejectReason}
                  <p class="text-sm text-danger">{card.rejectReason}</p>
                {/if}
              {/if}
            </div>
            {#if !card || card.status === 'rejected'}
              <Button
                size="sm"
                loading={working}
                onclick={() => requestCard(inmate.inmateId)}
              >
                ลงทะเบียน
              </Button>
            {/if}
          </li>
        {/each}
      </ul>
    </Card>

    <Card title="ยืนยันการฝากเงิน">
      <form class="space-y-3" onsubmit={submit}>
        <label class="block space-y-1.5">
          <span class="text-sm font-medium text-ink">ฝากให้</span>
          <select
            bind:value={inmateId}
            class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-ink"
          >
            {#each inmates as inmate (inmate.inmateId)}
              <option value={inmate.inmateId}>{inmate.fullName} ({inmate.inmateCode})</option>
            {/each}
          </select>
        </label>

        <label class="block space-y-1.5">
          <span class="text-sm font-medium text-ink">จำนวนเงิน (บาท)</span>
          <input
            bind:value={amountBaht}
            inputmode="decimal"
            placeholder="500.00"
            class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-ink"
          />
          {#if settings}
            <span class="text-sm text-muted">
              ขั้นต่ำ {formatBaht(settings.deposit.minSatang)} · สูงสุดต่อครั้ง
              {formatBaht(settings.deposit.maxSatang)}
            </span>
          {/if}
        </label>

        <label class="block space-y-1.5">
          <span class="text-sm font-medium text-ink">ชื่อผู้ฝาก</span>
          <input
            bind:value={depositorName}
            class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-ink"
          />
          <span class="text-sm text-muted">ใช้ชื่อผู้อื่นได้ หากโอนแทนคนในครอบครัว</span>
        </label>

        {#if requireCard && selectedCard?.status !== 'approved'}
          <Alert tone="info" title="ต้องมีบัตรฝากเงินที่อนุมัติแล้วก่อน">
            ลงทะเบียนบัตรด้านบน แล้วรอเจ้าหน้าที่อนุมัติ
          </Alert>
        {/if}

        <Button type="submit" full loading={working} disabled={!canDeposit || amountSatang <= 0}>
          ขอ QR ชำระเงิน
        </Button>
      </form>
    </Card>
  {/if}

  <section class="space-y-2">
    <h2 class="px-1 text-sm font-medium text-muted">ประวัติการฝากเงิน</h2>
    {#if loading}
      <p class="py-8 text-center text-muted">กำลังโหลด…</p>
    {:else if deposits.length === 0}
      <p class="py-8 text-center text-muted">ยังไม่มีรายการฝากเงิน</p>
    {:else}
      <ul class="space-y-2">
        {#each deposits as d (d.id)}
          <li>
            <a
              href="/deposits/{d.id}"
              class="flex items-center justify-between gap-3 rounded-xl border border-line
                     bg-surface px-4 py-3"
            >
              <div>
                <p class="font-mono text-sm text-muted">{d.depositNo}</p>
                <p class="font-medium text-ink">{d.inmateName}</p>
                <p class="text-sm text-muted">{formatDateTime(d.createdAt)}</p>
              </div>
              <div class="text-right">
                <p class="font-semibold text-ink">{formatBaht(d.amountSatang)}</p>
                <span class="mt-1 inline-block rounded-full px-2.5 py-1 text-xs {STATUS_TONE[d.status]}">
                  {STATUS_LABEL[d.status]}
                </span>
              </div>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</main>
