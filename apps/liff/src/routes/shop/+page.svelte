<script lang="ts">
  import type { ShopSummary } from '@pc/contract'
  import { SHOP_TYPE_LABEL } from '@pc/contract'
  import { Alert, Card } from '@pc/ui'
  import { api, session, toFormError } from '$lib/session.svelte.js'
  import { cart, type LinkedInmate } from '$lib/cart.svelte.js'

  let shops = $state<ShopSummary[]>([])
  let loading = $state(true)
  let error = $state('')

  const inmates = $derived(session.verifiedInmates)
  const selected = $derived(cart.inmate)

  // One verified inmate is the common case — skip the picker entirely.
  $effect(() => {
    if (!cart.inmate && inmates.length > 0) cart.inmate = inmates[0]!
  })

  $effect(() => {
    const inmate = cart.inmate
    if (!inmate) {
      loading = false
      return
    }
    loading = true
    api.catalog
      .shops({ prisonId: inmate.prisonId, zoneId: inmate.zoneId ?? undefined })
      .then((r) => {
        shops = r.items
        error = ''
      })
      .catch((err) => (error = toFormError(err).message))
      .finally(() => (loading = false))
  })

  function choose(inmate: LinkedInmate) {
    if (cart.inmate?.inmateId === inmate.inmateId) return
    cart.inmate = inmate
    // The cart belongs to one inmate at one shop; switching resets it.
    cart.clear()
  }
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <h1 class="text-xl font-semibold">ร้านค้า</h1>
  <p class="text-sm text-brand-100">เลือกร้านเพื่อสั่งซื้อสินค้าให้ผู้ต้องขัง</p>
</header>

<main class="space-y-4 p-4 pb-24">
  {#if inmates.length === 0}
    <Alert tone="warning" title="ยังสั่งซื้อไม่ได้">
      บัญชีของคุณยังไม่มีผู้ต้องขังที่เจ้าหน้าที่ยืนยันแล้ว กรุณาเพิ่มผู้ต้องขังในหน้าโปรไฟล์ก่อน
    </Alert>
  {:else}
    {#if inmates.length > 1}
      <Card title="สั่งซื้อให้">
        <div class="flex flex-wrap gap-2">
          {#each inmates as inmate (inmate.inmateId)}
            <button
              type="button"
              onclick={() => choose(inmate)}
              class="rounded-full px-4 py-1.5 text-sm transition
                     {selected?.inmateId === inmate.inmateId
                ? 'bg-brand-600 text-white'
                : 'border border-line bg-surface text-ink'}"
            >
              {inmate.fullName}
            </button>
          {/each}
        </div>
      </Card>
    {/if}

    {#if selected}
      <p class="text-sm text-muted">
        {selected.prisonName}{selected.zoneName ? ` · ${selected.zoneName}` : ''}
      </p>
    {/if}

    {#if error}
      <Alert tone="danger" title={error} />
    {/if}

    {#if loading}
      <p class="py-8 text-center text-muted">กำลังโหลด…</p>
    {:else if shops.length === 0}
      <Alert tone="info" title="ยังไม่มีร้านค้าเปิดให้บริการในแดนนี้" />
    {:else}
      <ul class="space-y-3">
        {#each shops as shop (shop.id)}
          <li>
            <a
              href="/shop/{shop.id}"
              class="block rounded-[var(--radius-card)] border border-line bg-surface p-4 shadow-sm
                     transition active:scale-[0.99]"
            >
              <div class="flex items-start justify-between gap-3">
                <div>
                  <p class="font-medium text-ink">{shop.name}</p>
                  <p class="text-sm text-muted">{SHOP_TYPE_LABEL[shop.shopType]}</p>
                </div>
                <span
                  class="shrink-0 rounded-full px-2.5 py-0.5 text-xs
                         {shop.isOpenNow ? 'bg-ok/15 text-ink' : 'bg-line text-muted'}"
                >
                  {shop.isOpenNow ? 'เปิดอยู่' : 'ปิดอยู่'}
                </span>
              </div>
              {#if shop.description}
                <p class="mt-2 text-sm text-muted">{shop.description}</p>
              {/if}
              <p class="mt-2 text-sm text-brand-700">สินค้า {shop.productCount} รายการ</p>
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</main>
