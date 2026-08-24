<script lang="ts">
  import { page } from '$app/state'

  const TABS = [
    { href: '/', label: 'หน้าแรก', icon: '🏠' },
    { href: '/orders', label: 'คำสั่งซื้อ', icon: '🧾' },
    { href: '/letters', label: 'จดหมาย', icon: '✉️' },
    { href: '/profile', label: 'บัญชี', icon: '👤' }
  ]

  const active = (href: string) =>
    href === '/' ? page.url.pathname === '/' : page.url.pathname.startsWith(href)
</script>

<nav
  class="fixed inset-x-0 bottom-0 z-20 mx-auto max-w-md border-t border-line bg-surface
         pb-[env(safe-area-inset-bottom)]"
  aria-label="เมนูหลัก"
>
  <ul class="grid grid-cols-4">
    {#each TABS as tab (tab.href)}
      <li>
        <a
          href={tab.href}
          aria-current={active(tab.href) ? 'page' : undefined}
          class="flex flex-col items-center gap-0.5 py-2.5 text-xs
                 {active(tab.href) ? 'text-brand-700' : 'text-muted'}"
        >
          <span aria-hidden="true" class="text-lg">{tab.icon}</span>
          {tab.label}
        </a>
      </li>
    {/each}
  </ul>
</nav>
