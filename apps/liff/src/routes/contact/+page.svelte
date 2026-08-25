<script lang="ts">
  import { Card } from '@pc/ui'
  import { api } from '$lib/session.svelte.js'
  import type { PublicSettings } from '@pc/contract'

  let settings = $state<PublicSettings | null>(null)

  $effect(() => {
    api.settings
      .public()
      .then((s) => (settings = s))
      .catch(() => (settings = null))
  })
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <h1 class="text-xl font-semibold">ติดต่อเรา</h1>
</header>

<main class="space-y-4 p-4">
  <Card title="ช่องทางติดต่อ">
    {#if settings}
      <dl class="space-y-3 text-sm">
        <div class="flex justify-between gap-4">
          <dt class="text-muted">โทรศัพท์</dt>
          <dd class="text-ink">{settings.contact.phone}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">อีเมล</dt>
          <dd class="text-ink">{settings.contact.email}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">LINE ทางการ</dt>
          <dd class="text-ink">{settings.contact.lineOfficial}</dd>
        </div>
        {#if settings.contact.addressTh}
          <div>
            <dt class="text-muted">ที่อยู่</dt>
            <dd class="mt-1 text-ink">{settings.contact.addressTh}</dd>
          </div>
        {/if}
      </dl>
    {:else}
      <p class="text-sm text-muted">กำลังโหลด…</p>
    {/if}
  </Card>

  <Card title="เวลาให้บริการ">
    <p class="text-sm text-muted">
      ปิดรับคำสั่งซื้อประจำวันเวลา {settings?.order.cutoffTime ?? '—'} น. · เปิดให้จองเยี่ยมล่วงหน้า {settings
        ?.visit.horizonWeeks ?? '—'} สัปดาห์
    </p>
  </Card>
</main>
