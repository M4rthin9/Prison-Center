<script lang="ts">
  import { Alert, Button, Card, formatBaht } from '@pc/ui'
  import { goto } from '$app/navigation'
  import { api, toFormError } from '$lib/session.svelte.js'
  import { cart } from '$lib/cart.svelte.js'

  let note = $state('')
  let placing = $state(false)
  let error = $state('')

  async function placeOrder() {
    if (cart.isEmpty || !cart.inmate || placing) return
    placing = true
    error = ''
    try {
      // The server re-prices everything; the total below is a preview only.
      const order = await api.orders.create(cart.toOrderInput(note))
      cart.clear()
      note = ''
      await goto(`/orders/${order.id}`, { replaceState: true })
    } catch (err) {
      error = toFormError(err).message
    } finally {
      placing = false
    }
  }
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <h1 class="text-xl font-semibold">ตะกร้าสินค้า</h1>
  {#if cart.shopName}<p class="text-sm text-brand-100">{cart.shopName}</p>{/if}
</header>

<main class="space-y-4 p-4 pb-28">
  {#if error}<Alert tone="danger" title={error} />{/if}

  {#if cart.isEmpty}
    <Alert tone="info" title="ตะกร้าว่างอยู่">
      <a class="text-brand-700 underline" href="/shop">เลือกซื้อสินค้า</a>
    </Alert>
  {:else}
    {#if cart.inmate}
      <Card title="ผู้รับสินค้า">
        <p class="font-medium text-ink">{cart.inmate.fullName}</p>
        <p class="text-sm text-muted">
          {cart.inmate.inmateCode} · {cart.inmate.prisonName}{cart.inmate.zoneName
            ? ` · ${cart.inmate.zoneName}`
            : ''}
        </p>
      </Card>
    {/if}

    <Card padded={false}>
      <ul class="divide-y divide-line">
        {#each cart.lines as line (line.product.id)}
          <li class="p-4">
            <div class="flex items-start justify-between gap-3">
              <div class="min-w-0">
                <p class="font-medium text-ink">{line.product.name}</p>
                <p class="text-sm text-muted">
                  {formatBaht(line.product.priceSatang)} / {line.product.unit}
                </p>
              </div>
              <p class="shrink-0 font-semibold text-ink">
                {formatBaht(line.product.priceSatang * line.qty)}
              </p>
            </div>

            <div class="mt-3 flex items-center gap-3">
              <button
                type="button"
                aria-label="ลดจำนวน"
                onclick={() => cart.setQty(line.product.id, line.qty - 1)}
                class="size-9 rounded-lg border border-line text-lg text-ink">−</button
              >
              <span class="min-w-6 text-center font-medium">{line.qty}</span>
              <button
                type="button"
                aria-label="เพิ่มจำนวน"
                onclick={() => cart.setQty(line.product.id, line.qty + 1)}
                class="size-9 rounded-lg border border-line text-lg text-ink">+</button
              >
              <button
                type="button"
                onclick={() => cart.remove(line.product.id)}
                class="ml-auto text-sm text-danger">นำออก</button
              >
            </div>
          </li>
        {/each}
      </ul>
    </Card>

    <Card title="หมายเหตุถึงเจ้าหน้าที่">
      <textarea
        bind:value={note}
        rows="3"
        maxlength="500"
        placeholder="เช่น ขอให้ส่งช่วงเช้า (ไม่บังคับ)"
        class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-ink
               placeholder:text-muted/60"></textarea>
    </Card>

    <Card>
      <div class="flex justify-between">
        <span class="text-muted">ยอดรวม {cart.count} ชิ้น</span>
        <span class="text-lg font-semibold text-ink">{formatBaht(cart.subtotalSatang)}</span>
      </div>
      <p class="mt-1 text-sm text-muted">
        ระบบจะคำนวณราคาอีกครั้งจากราคาปัจจุบันของร้านค้าเมื่อยืนยันคำสั่งซื้อ
      </p>
      <div class="mt-4">
        <Button full loading={placing} onclick={placeOrder}>ยืนยันคำสั่งซื้อ</Button>
      </div>
      <p class="mt-2 text-center text-sm text-muted">ชำระเงินจะเปิดให้ใช้งานในเฟส 2</p>
    </Card>
  {/if}
</main>
