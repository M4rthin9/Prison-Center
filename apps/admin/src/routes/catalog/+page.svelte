<script lang="ts">
  import type { PrisonSummary, ShopSummary, ShopType } from '@pc/contract'
  import { SHOP_TYPE_LABEL } from '@pc/contract'
  import { Alert, Button, Card, Field } from '@pc/ui'
  import { api, session, toFormError } from '$lib/session.svelte.js'

  let shops = $state<ShopSummary[]>([])
  let prisons = $state<PrisonSummary[]>([])
  let loading = $state(true)
  let message = $state('')
  let tone = $state<'danger' | 'success'>('success')

  // create form
  let name = $state('')
  let shopType = $state<ShopType>('prison_products')
  let description = $state('')
  let prisonId = $state('')
  let creating = $state(false)
  let fields = $state<Record<string, string[]>>({})

  async function load() {
    loading = true
    try {
      const [shopRes, prisonRes] = await Promise.all([
        api.admin.shops.list({ includeInactive: true }),
        api.prisons.list()
      ])
      shops = shopRes.items
      prisons = prisonRes.items
    } catch (err) {
      tone = 'danger'
      message = toFormError(err).message
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void load()
  })

  async function create(event: SubmitEvent) {
    event.preventDefault()
    creating = true
    message = ''
    fields = {}
    try {
      await api.admin.shops.create({
        // super_admin has no home facility, so it must name one explicitly.
        prisonId: session.isSuperAdmin ? prisonId : undefined,
        name,
        shopType,
        description: description || null
      })
      tone = 'success'
      message = `เพิ่มร้าน "${name}" แล้ว`
      name = ''
      description = ''
      await load()
    } catch (err) {
      const e = toFormError(err)
      tone = 'danger'
      message = e.message
      fields = e.fields
    } finally {
      creating = false
    }
  }

  async function toggleActive(shop: ShopSummary) {
    try {
      await api.admin.shops.update(shop.id, { isActive: !shop.isActive })
      await load()
    } catch (err) {
      tone = 'danger'
      message = toFormError(err).message
    }
  }
</script>

<div class="space-y-5">
  <div>
    <h1 class="text-2xl font-semibold text-ink">ร้านค้าและสินค้า</h1>
    <p class="text-muted">
      ร้านที่ไม่ระบุแดนจะให้บริการทุกแดนในเรือนจำ — การปิดร้านทำให้ญาติมองไม่เห็นร้านนั้นทันที
    </p>
  </div>

  {#if message}<Alert {tone} title={message} />{/if}

  <Card title="เพิ่มร้านค้า">
    <form class="grid gap-4 md:grid-cols-2" onsubmit={create}>
      <Field label="ชื่อร้าน" bind:value={name} required errors={fields.name} />

      <div class="space-y-1.5">
        <label for="shop-type" class="block text-sm font-medium text-ink">ประเภทร้าน</label>
        <select
          id="shop-type"
          bind:value={shopType}
          class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-ink"
        >
          <option value="prison_products">{SHOP_TYPE_LABEL.prison_products}</option>
          <option value="vocational_training">{SHOP_TYPE_LABEL.vocational_training}</option>
        </select>
      </div>

      {#if session.isSuperAdmin}
        <div class="space-y-1.5">
          <label for="shop-prison" class="block text-sm font-medium text-ink">เรือนจำ</label>
          <select
            id="shop-prison"
            bind:value={prisonId}
            required
            class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-ink"
          >
            <option value="" disabled>เลือกเรือนจำ</option>
            {#each prisons as p (p.id)}
              <option value={p.id}>{p.nameTh}</option>
            {/each}
          </select>
        </div>
      {/if}

      <Field label="คำอธิบาย" bind:value={description} errors={fields.description} />

      <div class="md:col-span-2">
        <Button type="submit" loading={creating}>เพิ่มร้านค้า</Button>
      </div>
    </form>
  </Card>

  <Card title="ร้านค้าทั้งหมด" padded={false}>
    <div class="overflow-x-auto">
      <table class="admin-table">
        <thead>
          <tr>
            <th>ร้าน</th>
            <th>ประเภท</th>
            <th>เรือนจำ / แดน</th>
            <th>สินค้า</th>
            <th>สถานะ</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each shops as shop (shop.id)}
            <tr>
              <td>
                <a class="font-medium text-brand-700" href="/catalog/{shop.id}">{shop.name}</a>
                {#if shop.description}
                  <p class="text-sm text-muted">{shop.description}</p>
                {/if}
              </td>
              <td>{SHOP_TYPE_LABEL[shop.shopType]}</td>
              <td>{shop.prisonName}{shop.zoneName ? ` · ${shop.zoneName}` : ' · ทุกแดน'}</td>
              <td>{shop.productCount}</td>
              <td>
                {#if shop.isActive}
                  <span class="rounded-full bg-ok/15 px-2.5 py-0.5 text-xs">
                    {shop.isOpenNow ? 'เปิดอยู่' : 'เปิดใช้งาน · นอกเวลา'}
                  </span>
                {:else}
                  <span class="rounded-full bg-line px-2.5 py-0.5 text-xs text-muted"
                    >ปิดใช้งาน</span
                  >
                {/if}
              </td>
              <td class="text-right whitespace-nowrap">
                <Button size="sm" variant="ghost" onclick={() => toggleActive(shop)}>
                  {shop.isActive ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}
                </Button>
                <a class="text-sm text-brand-700" href="/catalog/{shop.id}">จัดการสินค้า</a>
              </td>
            </tr>
          {:else}
            <tr>
              <td colspan="6" class="py-8 text-center text-muted">
                {loading ? 'กำลังโหลด…' : 'ยังไม่มีร้านค้า'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Card>
</div>
