<script lang="ts">
  import type { LetterCredits, LetterPackage, LetterStatus, LetterSummary } from '@pc/contract'
  import { Alert, Button, Card, formatBaht, formatDateTime } from '@pc/ui'
  import { goto } from '$app/navigation'
  import { api, session, toFormError } from '$lib/session.svelte.js'

  const STATUS_LABEL: Record<LetterStatus, string> = {
    draft: 'ฉบับร่าง',
    queued: 'รอพิมพ์',
    pending_print: 'อยู่ในรอบพิมพ์',
    printed: 'พิมพ์แล้ว',
    dispatched: 'นำส่งแดนแล้ว',
    delivered: 'ถึงมือแล้ว',
    rejected: 'ไม่สำเร็จ'
  }
  const STATUS_TONE: Record<LetterStatus, string> = {
    draft: 'bg-canvas text-muted',
    queued: 'bg-warn/15 text-ink',
    pending_print: 'bg-warn/15 text-ink',
    printed: 'bg-brand-50 text-brand-800',
    dispatched: 'bg-brand-50 text-brand-800',
    delivered: 'bg-ok/15 text-ink',
    rejected: 'bg-danger/10 text-danger'
  }

  let credits = $state<LetterCredits | null>(null)
  let packages = $state<LetterPackage[]>([])
  let letters = $state<LetterSummary[]>([])
  let tab = $state<'to_prison' | 'to_home'>('to_prison')
  let loading = $state(true)
  let working = $state(false)
  let error = $state('')

  const prisonId = $derived(session.verifiedInmates[0]?.prisonId ?? '')
  const balance = $derived(
    tab === 'to_prison' ? (credits?.balance.toPrison ?? 0) : (credits?.balance.toHome ?? 0)
  )
  const offered = $derived(packages.filter((p) => p.direction === tab))

  async function load() {
    loading = true
    try {
      const [c, p, l] = await Promise.all([
        api.letters.credits(),
        api.letters.packages(prisonId ? { prisonId } : {}),
        api.letters.list({ limit: 30 })
      ])
      credits = c
      packages = p.items
      letters = l.items
    } catch (err) {
      error = toFormError(err).message
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void load()
  })

  /** Buying creates the purchase and its QR in one call, like a deposit. */
  async function buy(pkg: LetterPackage) {
    working = true
    error = ''
    try {
      const purchase = await api.letters.purchase(pkg.id, prisonId ? { prisonId } : {})
      await goto(`/letters/purchases/${purchase.id}`)
    } catch (err) {
      error = toFormError(err).message
    } finally {
      working = false
    }
  }

  const shown = $derived(letters.filter((l) => l.direction === tab))
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <h1 class="text-xl font-semibold">จดหมายอิเล็กทรอนิกส์</h1>
  <p class="text-sm text-brand-100">ซื้อแพ็กเกจ เขียนจดหมาย และอ่านจดหมายตอบกลับ</p>
</header>

<main class="space-y-4 p-4 pb-24">
  {#if error}<Alert tone="danger" title={error} />{/if}

  {#if !session.canTransact}
    <Alert tone="warning" title="ยังส่งจดหมายไม่ได้">
      บัญชีของคุณต้องได้รับการยืนยันความสัมพันธ์กับผู้ต้องขังจากเจ้าหน้าที่ก่อน
    </Alert>
  {:else}
    <div class="grid grid-cols-2 gap-2">
      <button
        type="button"
        class="rounded-xl border px-3 py-2.5 text-sm
               {tab === 'to_prison'
          ? 'border-brand-700 bg-brand-50 font-medium text-brand-800'
          : 'border-line bg-surface text-ink'}"
        onclick={() => (tab = 'to_prison')}
      >
        ส่งเข้าเรือนจำ
      </button>
      <button
        type="button"
        class="rounded-xl border px-3 py-2.5 text-sm
               {tab === 'to_home'
          ? 'border-brand-700 bg-brand-50 font-medium text-brand-800'
          : 'border-line bg-surface text-ink'}"
        onclick={() => (tab = 'to_home')}
      >
        ตอบกลับถึงบ้าน
      </button>
    </div>

    <Card>
      <div class="flex items-baseline justify-between">
        <span class="text-muted">สิทธิ์คงเหลือ</span>
        <span class="text-2xl font-semibold text-ink"
          >{balance} <span class="text-base">ฉบับ</span></span
        >
      </div>
      {#if tab === 'to_prison'}
        <div class="mt-3">
          <Button full disabled={balance < 1} onclick={() => goto('/letters/compose')}>
            {balance < 1 ? 'ซื้อแพ็กเกจก่อนจึงจะเขียนได้' : 'เขียนจดหมายใหม่'}
          </Button>
        </div>
      {:else}
        <p class="mt-2 text-sm text-muted">ใช้สำหรับเปิดอ่านจดหมายที่ผู้ต้องขังเขียนตอบกลับมา</p>
      {/if}
    </Card>

    <Card title="ซื้อแพ็กเกจ" subtitle="สิทธิ์จะเข้าบัญชีเมื่อเจ้าหน้าที่ตรวจสลิปผ่านแล้ว">
      <ul class="space-y-3">
        {#each offered as pkg (pkg.id)}
          <li class="flex items-center justify-between gap-3">
            <div>
              <p class="font-medium text-ink">{pkg.name}</p>
              <p class="text-sm text-muted">{pkg.quota} ฉบับ · {formatBaht(pkg.priceSatang)}</p>
            </div>
            <Button size="sm" loading={working} onclick={() => buy(pkg)}>ซื้อ</Button>
          </li>
        {:else}
          <li class="py-4 text-center text-muted">ยังไม่มีแพ็กเกจสำหรับทิศทางนี้</li>
        {/each}
      </ul>
      <a class="mt-3 block text-sm text-brand-700" href="/letters/purchases">
        ประวัติการเติมสิทธิ์ →
      </a>
    </Card>
  {/if}

  <section class="space-y-2">
    <h2 class="px-1 text-sm font-medium text-muted">
      {tab === 'to_prison' ? 'จดหมายที่ส่งไป' : 'จดหมายตอบกลับ'}
    </h2>
    {#if loading}
      <p class="py-8 text-center text-muted">กำลังโหลด…</p>
    {:else if shown.length === 0}
      <p class="py-8 text-center text-muted">ยังไม่มีจดหมาย</p>
    {:else}
      <ul class="space-y-2">
        {#each shown as letter (letter.id)}
          <li>
            <a
              href="/letters/{letter.id}"
              class="flex items-start justify-between gap-3 rounded-xl border border-line
                     bg-surface px-4 py-3"
            >
              <div class="min-w-0">
                <p class="font-mono text-sm text-muted">{letter.letterNo}</p>
                <p class="font-medium text-ink">
                  {letter.direction === 'to_prison' ? 'ถึง' : 'จาก'}
                  {letter.inmateName ?? '—'}
                </p>
                <p class="truncate text-sm text-muted">
                  {letter.preview ||
                    (letter.direction === 'to_home' ? 'จดหมายลายมือที่สแกนมา' : '—')}
                </p>
                <p class="text-sm text-muted">{formatDateTime(letter.createdAt)}</p>
              </div>
              <span
                class="mt-1 shrink-0 rounded-full px-2.5 py-1 text-xs {STATUS_TONE[letter.status]}"
              >
                {letter.direction === 'to_home' && letter.status === 'queued'
                  ? 'รอเปิดอ่าน'
                  : STATUS_LABEL[letter.status]}
              </span>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</main>
