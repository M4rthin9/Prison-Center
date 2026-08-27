<script lang="ts">
  import '../app.css'
  import { page } from '$app/state'
  import { goto } from '$app/navigation'
  import { session } from '$lib/session.svelte.js'
  import BottomNav from '$lib/BottomNav.svelte'

  let { children } = $props()

  const PUBLIC_ROUTES = ['/login', '/register', '/forgot-password']

  $effect(() => {
    void session.boot()
  })

  // One guard for the whole app: unauthenticated users land on /login, and a
  // forced password change wins over every other route.
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
</script>

<div class="app-shell mx-auto max-w-md bg-canvas">
  {#if !session.ready}
    <div class="flex min-h-dvh items-center justify-center">
      <span
        class="size-8 animate-spin rounded-full border-3 border-brand-200 border-t-brand-600"
        aria-label="กำลังโหลด"
      ></span>
    </div>
  {:else}
    {@render children()}
  {/if}
</div>

{#if session.signedIn && !session.mustChangePassword}
  <BottomNav />
{/if}
