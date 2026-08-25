<script lang="ts">
  import type { Category, Product, ShopDetail } from '@pc/contract'
  import { Alert, Card, formatBaht } from '@pc/ui'
  import { page } from '$app/state'
  import { api, toFormError } from '$lib/session.svelte.js'
  import { cart } from '$lib/cart.svelte.js'

  const shopId = $derived(page.params.shopId!)

  let shop = $state<ShopDetail | null>(null)
  let categories = $state<Category[]>([])
  let products = $state<Product[]>([])
  let categoryId = $state<string | null>(null)
  let q = $state('')
  let nextCursor = $state<string | null>(null)
  let loading = $state(true)
  let loadingMore = $state(false)
  let error = $state('')
  let notice = $state('')

  const DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์']

  $effect(() => {
    const id = shopId
    Promise.all([api.catalog.shop(id), api.catalog.categories({ shopId: id })])
      .then(([s, c]) => {
        shop = s
        categories = c.items
      })
      .catch((err) => (error = toFormError(err).message))
  })

  // Re-runs whenever the filters change; the cursor resets with them.
  $effect(() => {
    const id = shopId
    const cat = categoryId
    const term = q.trim()
    loading = true
    api.catalog
      .products({ shopId: id, categoryId: cat ?? undefined, q: term || undefined, limit: 20 })
      .then((r) => {
        products = r.items
        nextCursor = r.nextCursor
        error = ''
      })
      .catch((err) => (error = toFormError(err).message))
      .finally(() => (loading = false))
  })

  async function loadMore() {
    if (!nextCursor || loadingMore) return
    loadingMore = true
    try {
      const r = await api.catalog.products({
        shopId,
        categoryId: categoryId ?? undefined,
        q: q.trim() || undefined,
        cursor: nextCursor,
        limit: 20
      })
      products = [...products, ...r.items]
      nextCursor = r.nextCursor
    } catch (err) {
      error = toFormError(err).message
    } finally {
      loadingMore = false
    }
  }

  function add(product: Product) {
    const outcome = cart.add(product, shop?.name ?? '')
    notice =
      outcome === 'replaced'
        ? `ตะกร้าเดิมมาจากร้านอื่น จึงเริ่มตะกร้าใหม่ด้วย "${product.name}"`
        : `เพิ่ม "${product.name}" ลงตะกร้าแล้ว`
  }
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <a class="text-sm text-brand-100" href="/shop">← ร้านค้าทั้งหมด</a>
  <h1 class="mt-1 text-xl font-semibold">{shop?.name ?? 'กำลังโหลด…'}</h1>
  {#if shop}
    <p class="text-sm text-brand-100">
      {shop.isOpenNow ? 'เปิดอยู่ตอนนี้' : 'ขณะนี้ปิดทำการ'}
      {#if cart.inmate}· สั่งให้ {cart.inmate.fullName}{/if}
    </p>
  {/if}
</header>

<main class="space-y-4 p-4 pb-28">
  {#if error}<Alert tone="danger" title={error} />{/if}
  {#if notice}<Alert tone="success" title={notice} />{/if}

  {#if !cart.inmate}
    <Alert tone="warning" title="ยังไม่ได้เลือกผู้ต้องขัง">
      <a class="text-brand-700 underline" href="/shop">เลือกผู้ต้องขังก่อนสั่งซื้อ</a>
    </Alert>
  {/if}

  <input
    type="search"
    bind:value={q}
    placeholder="ค้นหาสินค้า"
    class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-ink
           placeholder:text-muted/60"
  />

  {#if categories.length > 0}
    <div class="flex gap-2 overflow-x-auto pb-1">
      <button
        type="button"
        onclick={() => (categoryId = null)}
        class="shrink-0 rounded-full px-4 py-1.5 text-sm transition
               {categoryId === null
          ? 'bg-brand-600 text-white'
          : 'border border-line bg-surface text-ink'}"
      >
        ทั้งหมด
      </button>
      {#each categories as c (c.id)}
        <button
          type="button"
          onclick={() => (categoryId = c.id)}
          class="shrink-0 rounded-full px-4 py-1.5 text-sm transition
                 {categoryId === c.id
            ? 'bg-brand-600 text-white'
            : 'border border-line bg-surface text-ink'}"
        >
          {c.name}
        </button>
      {/each}
    </div>
  {/if}

  {#if loading}
    <p class="py-8 text-center text-muted">กำลังโหลด…</p>
  {:else if products.length === 0}
    <Alert tone="info" title="ไม่พบสินค้าตามเงื่อนไขนี้" />
  {:else}
    <ul class="space-y-3">
      {#each products as product (product.id)}
        {@const inCart = cart.qtyOf(product.id)}
        <li class="rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-sm">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p class="font-medium text-ink">{product.name}</p>
              <p class="text-sm text-muted">
                {product.categoryName ?? '—'} · ต่อ {product.unit}
                {#if product.maxPerOrder > 0}
                  · สูงสุด {product.maxPerOrder}
                {/if}
              </p>
            </div>
            <p class="shrink-0 font-semibold text-ink">{formatBaht(product.priceSatang)}</p>
          </div>

          <div class="mt-3 flex items-center justify-between">
            {#if inCart > 0}
              <div class="flex items-center gap-3">
                <button
                  type="button"
                  aria-label="ลดจำนวน"
                  onclick={() => cart.setQty(product.id, inCart - 1)}
                  class="size-9 rounded-lg border border-line text-lg text-ink"
                >
                  −
                </button>
                <span class="min-w-6 text-center font-medium">{inCart}</span>
                <button
                  type="button"
                  aria-label="เพิ่มจำนวน"
                  onclick={() => cart.setQty(product.id, inCart + 1)}
                  class="size-9 rounded-lg border border-line text-lg text-ink"
                >
                  +
                </button>
              </div>
              <span class="text-sm text-muted">
                {formatBaht(product.priceSatang * inCart)}
              </span>
            {:else}
              <button
                type="button"
                disabled={!cart.inmate}
                onclick={() => add(product)}
                class="h-9 rounded-xl bg-brand-600 px-4 text-sm font-medium text-white
                       disabled:cursor-not-allowed disabled:bg-brand-300"
              >
                ใส่ตะกร้า
              </button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>

    {#if nextCursor}
      <button
        type="button"
        onclick={loadMore}
        disabled={loadingMore}
        class="w-full rounded-xl border border-line bg-surface py-3 text-sm text-ink"
      >
        {loadingMore ? 'กำลังโหลด…' : 'ดูสินค้าเพิ่มเติม'}
      </button>
    {/if}
  {/if}

  {#if shop}
    <Card
      title="เวลาทำการ"
      subtitle={shop.hoursSource === 'shop' ? 'เวลาของร้านนี้' : 'เวลาของเรือนจำ'}
    >
      <ul class="divide-y divide-line text-sm">
        {#each shop.hours as h (h.weekday)}
          <li class="flex justify-between py-1.5">
            <span class="text-ink">{DAYS[h.weekday]}</span>
            <span class="text-muted">{h.isOpen ? `${h.opensAt} – ${h.closesAt}` : 'ปิด'}</span>
          </li>
        {/each}
      </ul>
    </Card>
  {/if}
</main>

{#if cart.count > 0}
  <a
    href="/cart"
    class="fixed inset-x-0 bottom-16 z-30 mx-auto flex max-w-md items-center justify-between
           gap-3 border-t border-line bg-brand-700 px-5 py-3 text-white"
  >
    <span>ตะกร้า {cart.count} ชิ้น</span>
    <span class="font-semibold">{formatBaht(cart.subtotalSatang)} · ดูตะกร้า →</span>
  </a>
{/if}
