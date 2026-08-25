<script lang="ts">
  import { Card } from '@pc/ui'
  import { api } from '$lib/session.svelte.js'
  import type { PrisonSummary } from '@pc/contract'

  let prisons = $state<PrisonSummary[]>([])

  $effect(() => {
    api.prisons
      .list()
      .then((r) => (prisons = r.items))
      .catch(() => (prisons = []))
  })
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <h1 class="text-xl font-semibold">เกี่ยวกับเรา</h1>
</header>

<main class="space-y-4 p-4">
  <Card title="ศูนย์บริการระบบโปรแกรมจำหน่ายสินค้าเรือนจำ">
    <p class="text-sm text-muted">
      ช่องทางเดียวสำหรับญาติผู้ต้องขังในการสั่งซื้อสินค้าจากร้านค้าเรือนจำ ฝากเงิน
      ส่งจดหมายอิเล็กทรอนิกส์ และจองเข้าเยี่ยม
      โดยทุกบริการผูกกับผู้ต้องขังที่เจ้าหน้าที่ยืนยันแล้วเท่านั้น
    </p>
  </Card>

  <Card title="เรือนจำที่เปิดให้บริการ">
    <ul class="divide-y divide-line">
      {#each prisons as p (p.id)}
        <li class="py-3 first:pt-0 last:pb-0">
          <p class="font-medium text-ink">{p.nameTh}</p>
          <p class="text-sm text-muted">{p.province ?? ''} · {p.zoneCount} แดน</p>
        </li>
      {:else}
        <li class="py-3 text-sm text-muted">ยังไม่มีข้อมูล</li>
      {/each}
    </ul>
  </Card>
</main>
