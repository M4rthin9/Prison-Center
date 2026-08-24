<script lang="ts">
  import { session } from '$lib/session.svelte.js'
  import MenuTile from '$lib/MenuTile.svelte'
  import { Alert } from '@pc/ui'

  // p.13 — the LINE@ menu, in the order the diagram lists it.
  const MENU = [
    { href: '/shop', label: 'ร้านค้า', icon: '🛒', needsVerify: true },
    { href: '/visits', label: 'จองเยี่ยม', icon: '📅', needsVerify: true },
    { href: '/deposits', label: 'การฝากเงิน', icon: '💰', needsVerify: true },
    { href: '/letters', label: 'จดหมาย', icon: '✉️', needsVerify: true },
    { href: '/news', label: 'ข่าวสาร', icon: '📰', needsVerify: false },
    { href: '/orders', label: 'ประวัติการสั่งซื้อ', icon: '🧾', needsVerify: true },
    { href: '/about', label: 'เกี่ยวกับเรา', icon: 'ℹ️', needsVerify: false },
    { href: '/contact', label: 'ติดต่อเรา', icon: '☎️', needsVerify: false }
  ]
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <p class="text-sm text-brand-100">ยินดีต้อนรับ</p>
  <h1 class="text-xl font-semibold">{session.me?.fullName ?? ''}</h1>
  {#if session.verifiedInmates.length > 0}
    <p class="mt-2 text-sm text-brand-100">
      ผู้ต้องขังที่ยืนยันแล้ว:
      {session.verifiedInmates.map((i) => i.fullName).join(', ')}
    </p>
  {/if}
</header>

<main class="space-y-5 p-4">
  {#if !session.canTransact}
    <Alert tone="warning" title="ยังใช้บริการไม่ได้">
      บัญชีของคุณยังไม่ได้รับการยืนยันความสัมพันธ์กับผู้ต้องขัง
      กรุณาเพิ่มผู้ต้องขังในหน้าโปรไฟล์และรอเจ้าหน้าที่ตรวจสอบ
      จึงจะสั่งซื้อสินค้า ฝากเงิน ส่งจดหมาย หรือจองเยี่ยมได้
    </Alert>
  {/if}

  <nav class="grid grid-cols-2 gap-3">
    {#each MENU as item (item.href)}
      <MenuTile
        href={item.href}
        label={item.label}
        icon={item.icon}
        locked={item.needsVerify && !session.canTransact}
      />
    {/each}
  </nav>
</main>
