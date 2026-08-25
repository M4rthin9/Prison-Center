<script lang="ts">
  import { page } from '$app/state'
  import { session } from '$lib/session.svelte.js'

  const LINKS = [
    { href: '/', label: 'ภาพรวม', icon: '📊', superOnly: false },
    { href: '/orders', label: 'คำสั่งซื้อ', icon: '🧾', superOnly: false },
    { href: '/catalog', label: 'ร้านค้าและสินค้า', icon: '🛒', superOnly: false },
    { href: '/customers/verify', label: 'คำขอผูกบัญชี', icon: '✅', superOnly: false },
    { href: '/customers', label: 'บัญชีญาติ', icon: '👥', superOnly: false },
    { href: '/staff', label: 'เจ้าหน้าที่', icon: '🛡️', superOnly: true },
    { href: '/settings', label: 'ตั้งค่าระบบ', icon: '⚙️', superOnly: false }
  ]

  const visible = $derived(LINKS.filter((l) => !l.superOnly || session.isSuperAdmin))
  const active = (href: string) => {
    if (href === '/') return page.url.pathname === '/'
    if (href === '/customers') return page.url.pathname === '/customers'
    return page.url.pathname.startsWith(href)
  }
</script>

<aside class="flex w-60 shrink-0 flex-col border-r border-line bg-surface">
  <div class="border-b border-line px-5 py-4">
    <p class="font-semibold text-ink">ระบบหลังบ้าน</p>
    <p class="text-xs text-muted">ศูนย์บริการเรือนจำ</p>
  </div>

  <nav class="flex-1 p-3">
    <ul class="space-y-1">
      {#each visible as link (link.href)}
        <li>
          <a
            href={link.href}
            aria-current={active(link.href) ? 'page' : undefined}
            class="flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition
                   {active(link.href)
              ? 'bg-brand-50 font-medium text-brand-800'
              : 'text-ink hover:bg-canvas'}"
          >
            <span aria-hidden="true">{link.icon}</span>
            {link.label}
          </a>
        </li>
      {/each}
    </ul>
  </nav>

  <div class="border-t border-line p-3">
    <a class="block rounded-lg px-3 py-2 text-sm text-ink hover:bg-canvas" href="/change-password">
      เปลี่ยนรหัสผ่าน
    </a>
    <button
      type="button"
      class="w-full rounded-lg px-3 py-2 text-left text-sm text-danger hover:bg-canvas"
      onclick={() => session.signOut()}
    >
      ออกจากระบบ
    </button>
  </div>
</aside>
