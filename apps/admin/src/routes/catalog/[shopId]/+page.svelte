<script lang="ts">
  import type { Category, Product, ProductType, ShopDetail, ShopHour } from '@pc/contract'
  import { PRODUCT_TYPE_LABEL } from '@pc/contract'
  import { Alert, Button, Card, Field, formatBaht } from '@pc/ui'
  import { page } from '$app/state'
  import { api, toFormError } from '$lib/session.svelte.js'

  const shopId = $derived(page.params.shopId!)

  let shop = $state<ShopDetail | null>(null)
  let products = $state<Product[]>([])
  let categories = $state<Category[]>([])
  let hours = $state<ShopHour[]>([])
  let loading = $state(true)
  let message = $state('')
  let tone = $state<'danger' | 'success'>('success')
  let savingHours = $state(false)

  // create form — price is entered in baht and converted once, here.
  let sku = $state('')
  let name = $state('')
  let priceBaht = $state('')
  let unit = $state('ชิ้น')
  let categoryId = $state('')
  let productType = $state<ProductType>('packaged_goods')
  let maxPerOrder = $state('0')
  let creating = $state(false)
  let fields = $state<Record<string, string[]>>({})

  const DAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์']

  async function load() {
    loading = true
    try {
      const [s, p, c] = await Promise.all([
        api.admin.shops.get(shopId),
        api.admin.products.list({ shopId, includeInactive: true, limit: 100 }),
        api.admin.categories.list()
      ])
      shop = s
      hours = s.hours.map((h) => ({ ...h }))
      products = p.items
      categories = c.items
    } catch (err) {
      tone = 'danger'
      message = toFormError(err).message
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void shopId
    void load()
  })

  async function create(event: SubmitEvent) {
    event.preventDefault()
    creating = true
    message = ''
    fields = {}
    try {
      await api.admin.products.create({
        shopId,
        sku,
        name,
        // Satang is the only money unit that crosses the wire.
        priceSatang: Math.round(Number(priceBaht) * 100),
        unit,
        productType,
        categoryId: categoryId || null,
        maxPerOrder: Number(maxPerOrder) || 0
      })
      tone = 'success'
      message = `เพิ่มสินค้า "${name}" แล้ว`
      sku = ''
      name = ''
      priceBaht = ''
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

  async function toggleProduct(product: Product) {
    try {
      await api.admin.products.update(product.id, { isActive: !product.isActive })
      await load()
    } catch (err) {
      tone = 'danger'
      message = toFormError(err).message
    }
  }

  async function editPrice(product: Product) {
    const input = prompt(
      `ราคาใหม่ของ "${product.name}" (บาท)`,
      (product.priceSatang / 100).toFixed(2)
    )
    if (input === null) return
    const value = Number(input)
    if (!Number.isFinite(value) || value < 0) {
      tone = 'danger'
      message = 'ราคาไม่ถูกต้อง'
      return
    }
    try {
      await api.admin.products.update(product.id, { priceSatang: Math.round(value * 100) })
      tone = 'success'
      message = `แก้ราคา "${product.name}" แล้ว — คำสั่งซื้อเดิมไม่เปลี่ยนแปลง`
      await load()
    } catch (err) {
      tone = 'danger'
      message = toFormError(err).message
    }
  }

  async function saveHours() {
    savingHours = true
    message = ''
    try {
      const res = await api.admin.shops.setHours(shopId, { hours })
      shop = res
      tone = 'success'
      message = 'บันทึกเวลาทำการแล้ว'
    } catch (err) {
      tone = 'danger'
      message = toFormError(err).message
    } finally {
      savingHours = false
    }
  }
</script>

<div class="space-y-5">
  <div>
    <a class="text-sm text-brand-700" href="/catalog">← ร้านค้าทั้งหมด</a>
    <h1 class="text-2xl font-semibold text-ink">{shop?.name ?? 'กำลังโหลด…'}</h1>
    {#if shop}
      <p class="text-muted">
        {shop.prisonName}{shop.zoneName ? ` · ${shop.zoneName}` : ' · ทุกแดน'} ·
        {shop.isOpenNow ? 'เปิดอยู่ตอนนี้' : 'ปิดอยู่ตอนนี้'}
      </p>
    {/if}
  </div>

  {#if message}<Alert {tone} title={message} />{/if}

  <Card title="เพิ่มสินค้า">
    <form class="grid gap-4 md:grid-cols-3" onsubmit={create}>
      <Field label="รหัสสินค้า (SKU)" bind:value={sku} required errors={fields.sku} />
      <Field label="ชื่อสินค้า" bind:value={name} required errors={fields.name} />
      <Field
        label="ราคา (บาท)"
        type="number"
        bind:value={priceBaht}
        required
        errors={fields.priceSatang}
      />
      <Field label="หน่วย" bind:value={unit} required errors={fields.unit} />

      <div class="space-y-1.5">
        <label for="p-cat" class="block text-sm font-medium text-ink">หมวดหมู่</label>
        <select
          id="p-cat"
          bind:value={categoryId}
          class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-ink"
        >
          <option value="">— ไม่ระบุ —</option>
          {#each categories as c (c.id)}
            <option value={c.id}>{c.name}</option>
          {/each}
        </select>
      </div>

      <div class="space-y-1.5">
        <label for="p-type" class="block text-sm font-medium text-ink">ประเภทสินค้า</label>
        <select
          id="p-type"
          bind:value={productType}
          class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-ink"
        >
          <option value="packaged_goods">{PRODUCT_TYPE_LABEL.packaged_goods}</option>
          <option value="food_beverage">{PRODUCT_TYPE_LABEL.food_beverage}</option>
        </select>
      </div>

      <Field
        label="จำกัดต่อคำสั่งซื้อ (0 = ไม่จำกัด)"
        type="number"
        bind:value={maxPerOrder}
        errors={fields.maxPerOrder}
      />

      <div class="md:col-span-3">
        <Button type="submit" loading={creating}>เพิ่มสินค้า</Button>
      </div>
    </form>
  </Card>

  <Card title="สินค้าในร้าน" padded={false}>
    <div class="overflow-x-auto">
      <table class="admin-table">
        <thead>
          <tr>
            <th>SKU</th>
            <th>ชื่อสินค้า</th>
            <th>หมวดหมู่</th>
            <th>ราคา</th>
            <th>หน่วย</th>
            <th>จำกัด</th>
            <th>สถานะ</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each products as product (product.id)}
            <tr>
              <td class="font-mono text-sm">{product.sku}</td>
              <td class="font-medium text-ink">{product.name}</td>
              <td>{product.categoryName ?? '—'}</td>
              <td>{formatBaht(product.priceSatang)}</td>
              <td>{product.unit}</td>
              <td>{product.maxPerOrder > 0 ? product.maxPerOrder : '—'}</td>
              <td>
                {#if product.isActive}
                  <span class="rounded-full bg-ok/15 px-2.5 py-0.5 text-xs">ขายอยู่</span>
                {:else}
                  <span class="rounded-full bg-line px-2.5 py-0.5 text-xs text-muted">งดขาย</span>
                {/if}
              </td>
              <td class="text-right whitespace-nowrap">
                <Button size="sm" variant="ghost" onclick={() => editPrice(product)}>แก้ราคา</Button
                >
                <Button size="sm" variant="ghost" onclick={() => toggleProduct(product)}>
                  {product.isActive ? 'งดขาย' : 'เปิดขาย'}
                </Button>
              </td>
            </tr>
          {:else}
            <tr>
              <td colspan="8" class="py-8 text-center text-muted">
                {loading ? 'กำลังโหลด…' : 'ยังไม่มีสินค้าในร้านนี้'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Card>

  <Card
    title="เวลาทำการ"
    subtitle={shop?.hoursSource === 'shop'
      ? 'ร้านนี้ใช้เวลาทำการของตัวเอง'
      : 'ยังใช้เวลาทำการของเรือนจำ — บันทึกเพื่อกำหนดเฉพาะร้านนี้'}
  >
    <div class="space-y-2">
      {#each hours as hour (hour.weekday)}
        <div class="flex items-center gap-3">
          <span class="w-24 text-sm text-ink">{DAYS[hour.weekday]}</span>
          <label class="flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" bind:checked={hour.isOpen} />
            เปิด
          </label>
          <input
            type="time"
            bind:value={hour.opensAt}
            disabled={!hour.isOpen}
            class="rounded-lg border border-line bg-white px-2.5 py-1.5 text-ink disabled:bg-canvas"
          />
          <span class="text-muted">–</span>
          <input
            type="time"
            bind:value={hour.closesAt}
            disabled={!hour.isOpen}
            class="rounded-lg border border-line bg-white px-2.5 py-1.5 text-ink disabled:bg-canvas"
          />
        </div>
      {/each}
    </div>
    <div class="mt-4">
      <Button loading={savingHours} onclick={saveHours}>บันทึกเวลาทำการ</Button>
    </div>
    <p class="mt-2 text-sm text-muted">
      เวลาทำการมีผลกับการสั่งซื้อก็ต่อเมื่อเปิดการตั้งค่า “บังคับเวลาทำการร้านค้า” ในหน้าตั้งค่าระบบ
    </p>
  </Card>
</div>
