<script lang="ts">
  import '../app.css'
  import { page } from '$app/state'
  import { goto } from '$app/navigation'
  import { session } from '$lib/session.svelte.js'
  import Sidebar from '$lib/Sidebar.svelte'

  let { children } = $props()

  const PUBLIC_ROUTES = ['/login']

  $effect(() => {
    void session.boot()
  })

  $effect(() => {
    if (!session.ready) return
    const path = page.url.pathname
    const isPublic = PUBLIC_ROUTES.includes(path)

    if (!session.signedIn && !isPublic) {
      goto(`/login?next=${encodeURIComponent(path)}`, { replaceState: true })
      return
    }
    if (session.signedIn && session.mustChangePassword && path !== '/change-password') {
      goto('/change-password', { replaceState: true })
      return
    }
    if (session.signedIn && !session.mustChangePassword && isPublic) {
      goto('/', { replaceState: true })
    }
  })

  const chromeless = $derived(
    !session.signedIn || session.mustChangePassword || PUBLIC_ROUTES.includes(page.url.pathname)
  )
</script>

{#if !session.ready}
  <div class="flex min-h-dvh items-center justify-center">
    <span
      class="size-8 animate-spin rounded-full border-3 border-brand-200 border-t-brand-600"
      aria-label="กำลังโหลด"
    ></span>
  </div>
{:else if chromeless}
  {@render children()}
{:else}
  <div class="flex min-h-dvh">
    <Sidebar />
    <div class="min-w-0 flex-1">
      <header
        class="flex items-center justify-between gap-4 border-b border-line bg-surface px-6 py-3"
      >
        <div>
          <p class="text-sm text-muted">ขอบเขตข้อมูล</p>
          <p class="font-medium text-ink">{session.scopeLabel}</p>
        </div>
        <div class="text-right">
          <p class="font-medium text-ink">{session.me?.fullName}</p>
          <p class="text-sm text-muted">{session.me?.username}</p>
        </div>
      </header>
      <main class="p-6">{@render children()}</main>
    </div>
  </div>
{/if}
