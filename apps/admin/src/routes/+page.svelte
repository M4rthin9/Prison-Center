<script lang="ts">
  import type { DashboardPeriod, DashboardSummary } from '@pc/contract'
  import { Alert, Card, formatBaht, formatDateTime } from '@pc/ui'
  import PeriodChart from '$lib/PeriodChart.svelte'
  import { api, ROLE_LABEL, session, toFormError } from '$lib/session.svelte.js'

  const PERIODS: { key: DashboardPeriod; label: string }[] = [
    { key: 'today', label: 'วันนี้' },
    { key: 'week', label: '7 วัน' },
    { key: 'month', label: 'เดือนนี้' },
    { key: 'year', label: 'ปีนี้' },
    { key: 'custom', label: 'กำหนดเอง' }
  ]

  let period = $state<DashboardPeriod>('month')
  let from = $state('')
  let to = $state('')
  let data = $state<DashboardSummary | null>(null)
  let loading = $state(true)
  let error = $state('')

  async function load() {
    if (period === 'custom' && (!from || !to)) return
    loading = true
    try {
      data = await api.admin.dashboard({
        period,
        from: period === 'custom' ? from : undefined,
        to: period === 'custom' ? to : undefined
      })
      error = ''
    } catch (err) {
      error = toFormError(err).message
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void period
    void from
    void to
    void load()
  })

  const pct = (v: number) => `${Math.round(v * 100)}%`

  /** The four p.11 tiles, each with the one number staff actually act on. */
  const tiles = $derived(
    data
      ? [
          {
            label: 'คำสั่งซื้อ',
            value: String(data.orders.count),
            unit: 'รายการ',
            lines: [
              `ชำระแล้ว ${data.orders.paidCount} · ${formatBaht(data.orders.paidSatang)}`,
              `รอจัดเตรียม ${data.orders.awaitingFulfillmentCount}`
            ],
            href: '/orders'
          },
          {
            label: 'การจองเยี่ยม',
            value: String(data.visits.bookedCount),
            unit: `จาก ${data.visits.capacityTotal} ที่นั่ง`,
            lines: [
              `ใช้ที่นั่ง ${pct(data.visits.utilisation)}`,
              `เช็คอิน ${data.visits.checkedInCount} · ไม่มา ${data.visits.noShowCount}`
            ],
            href: '/visits'
          },
          {
            label: 'จดหมายอิเล็กทรอนิกส์',
            value: String(data.letters.count),
            unit: 'ฉบับ',
            lines: [
              `รอพิมพ์ ${data.letters.awaitingPrintCount} · พิมพ์แล้ว ${data.letters.printedCount}`,
              `ขายคูปอง ${formatBaht(data.letters.creditsSoldSatang)}`
            ],
            href: '/letters'
          },
          {
            label: 'การฝากเงิน',
            value: formatBaht(data.deposits.receivedSatang),
            unit: `${data.deposits.count} รายการ`,
            lines: [
              `รอโอนเข้าบัญชี ${data.deposits.reviewingCount}`,
              `โอนแล้ว ${formatBaht(data.deposits.completedSatang)}`
            ],
            href: '/deposits'
          }
        ]
      : []
  )

  /** Work waiting on a human — not filtered by the period selector. */
  const queues = $derived(
    data
      ? [
          { label: 'สลิปรอตรวจสอบ', n: data.queues.paymentsAwaitingReview, href: '/payments' },
          { label: 'ฝากเงินรอโอน', n: data.queues.depositsAwaitingReview, href: '/deposits' },
          { label: 'จดหมายรอพิมพ์', n: data.queues.lettersAwaitingPrint, href: '/letters' },
          { label: 'คำสั่งซื้อรอจัดเตรียม', n: data.queues.ordersAwaitingFulfillment, href: '/orders' },
          { label: 'คำขอผูกบัญชี', n: data.queues.inmateLinksAwaitingVerify, href: '/customers/verify' },
          { label: 'บัตรฝากเงินรออนุมัติ', n: data.queues.depositCardsAwaitingReview, href: '/deposits' }
        ]
      : []
  )
</script>

<div class="space-y-5">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-2xl font-semibold text-ink">ภาพรวม</h1>
      <p class="text-muted">
        {ROLE_LABEL[session.me?.role ?? ''] ?? ''} · {session.scopeLabel}
        {#if data}
          · {data.from} ถึง {data.to}
        {/if}
      </p>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <div class="flex rounded-lg border border-line bg-surface p-1">
        {#each PERIODS as p (p.key)}
          <button
            type="button"
            class="rounded-md px-3 py-1.5 text-sm transition
                   {period === p.key ? 'bg-brand-50 font-medium text-brand-800' : 'text-muted hover:text-ink'}"
            onclick={() => (period = p.key)}
          >
            {p.label}
          </button>
        {/each}
      </div>
      {#if period === 'custom'}
        <input type="date" bind:value={from} aria-label="ตั้งแต่วันที่"
          class="rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink" />
        <input type="date" bind:value={to} aria-label="ถึงวันที่"
          class="rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink" />
      {/if}
    </div>
  </div>

  {#if error}
    <Alert tone="danger" title={error} />
  {/if}

  {#if period === 'custom' && (!from || !to)}
    <Alert tone="info" title="เลือกวันเริ่มต้นและวันสิ้นสุดเพื่อดูข้อมูล" />
  {/if}

  <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-busy={loading}>
    {#each tiles as tile (tile.label)}
      <a href={tile.href} class="block rounded-[var(--radius-card)] transition hover:opacity-90">
        <Card>
          <p class="text-sm text-muted">{tile.label}</p>
          <p class="mt-1 text-3xl font-semibold text-ink">{tile.value}</p>
          <p class="text-xs text-muted">{tile.unit}</p>
          <div class="mt-3 space-y-0.5 border-t border-line pt-2 text-xs text-muted">
            {#each tile.lines as line (line)}
              <p>{line}</p>
            {/each}
          </div>
        </Card>
      </a>
    {:else}
      {#each [1, 2, 3, 4] as n (n)}
        <Card>
          <p class="text-sm text-muted">กำลังโหลด…</p>
          <p class="mt-1 text-3xl font-semibold text-line">—</p>
        </Card>
      {/each}
    {/each}
  </div>

  {#if data}
    <Card title="แนวโน้มรายวัน" subtitle="{data.from} ถึง {data.to} · เวลาไทย">
      <div class="grid gap-6 sm:grid-cols-2">
        <PeriodChart
          points={data.series}
          metric="paidSatang"
          label="ยอดขายที่ชำระแล้ว"
          format={(v) => formatBaht(v)}
        />
        <PeriodChart
          points={data.series}
          metric="depositSatang"
          label="ยอดฝากเงินที่ได้รับ"
          format={(v) => formatBaht(v)}
        />
        <PeriodChart points={data.series} metric="visits" label="การเยี่ยม (ตามวันเข้าเยี่ยม)" />
        <PeriodChart points={data.series} metric="letters" label="จดหมาย" />
      </div>
    </Card>

    <div class="grid gap-4 lg:grid-cols-2">
      <Card title="งานที่รอเจ้าหน้าที่" subtitle="นับทั้งหมด ไม่ขึ้นกับช่วงเวลาที่เลือก">
        <ul class="divide-y divide-line">
          {#each queues as q (q.label)}
            <li class="flex items-center justify-between py-2">
              <a class="text-sm text-ink hover:underline" href={q.href}>{q.label}</a>
              <span
                class="rounded-full px-2.5 py-0.5 text-sm font-medium
                       {q.n > 0 ? 'bg-brand-50 text-brand-800' : 'text-muted'}"
              >
                {q.n}
              </span>
            </li>
          {/each}
        </ul>
      </Card>

      <Card title="รายงาน" subtitle="ออกไฟล์ XLSX ทั้ง 7 รายงานตามช่วงเวลา">
        <p class="text-sm text-muted">
          รายงานถูกสร้างในคิวงาน ไม่ต้องรอหน้าจอ เมื่อสร้างเสร็จจะดาวน์โหลดได้จากหน้ารายงาน
        </p>
        <a
          class="mt-3 inline-block rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white"
          href="/reports"
        >
          ไปที่หน้ารายงาน
        </a>
        <p class="mt-4 text-xs text-muted">
          ข้อมูล ณ {formatDateTime(data.generatedAt)}
        </p>
      </Card>
    </div>
  {/if}
</div>
