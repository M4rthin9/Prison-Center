<script lang="ts">
  import type { NewsSummary } from '@pc/contract'
  import { Alert, Button, formatDate } from '@pc/ui'
  import { api, session } from '$lib/session.svelte.js'

  let items = $state<NewsSummary[]>([])
  let nextCursor = $state<string | null>(null)
  let loading = $state(true)
  let error = $state('')

  /**
   * The feed follows whichever prison this relative is linked to; department
   * wide notices come back regardless. Signed out, it is the department feed.
   */
  const prisonId = $derived(session.me?.inmates[0]?.prisonId)

  async function load(cursor?: string) {
    loading = true
    try {
      const page = await api.news.list({ prisonId, cursor, limit: 20 })
      items = cursor ? [...items, ...page.items] : page.items
      nextCursor = page.nextCursor
      error = ''
    } catch {
      error = 'โหลดข่าวสารไม่สำเร็จ กรุณาลองใหม่'
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void prisonId
    void load()
  })
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <h1 class="text-xl font-semibold">ข่าวสาร</h1>
  <p class="text-sm text-white/80">ประกาศจากเรือนจำและกรมราชทัณฑ์</p>
</header>

<main class="space-y-3 p-4">
  {#if error}
    <Alert tone="danger" title={error} />
  {/if}

  {#each items as item (item.id)}
    <a
      href="/news/{encodeURIComponent(item.slug)}"
      class="block overflow-hidden rounded-[var(--radius-card)] border border-line bg-surface shadow-sm"
    >
      {#if item.coverImageUrl}
        <img src={item.coverImageUrl} alt="" class="h-40 w-full object-cover" />
      {/if}
      <div class="p-4">
        <p class="text-xs text-muted">
          {#if item.isPinned}<span class="mr-1">📌</span>{/if}
          {formatDate(item.publishedAt)} · {item.prisonName ?? 'ประกาศส่วนกลาง'}
        </p>
        <h2 class="mt-1 font-semibold text-ink">{item.title}</h2>
        {#if item.excerpt}
          <p class="mt-1 line-clamp-2 text-sm text-muted">{item.excerpt}</p>
        {/if}
      </div>
    </a>
  {:else}
    {#if !loading}
      <p class="py-16 text-center text-sm text-muted">ยังไม่มีข่าวสารในขณะนี้</p>
    {/if}
  {/each}

  {#if loading && items.length === 0}
    <p class="py-16 text-center text-sm text-muted">กำลังโหลด…</p>
  {/if}

  {#if nextCursor}
    <Button variant="ghost" loading={loading} onclick={() => load(nextCursor ?? undefined)}>
      ดูข่าวเก่ากว่านี้
    </Button>
  {/if}
</main>
