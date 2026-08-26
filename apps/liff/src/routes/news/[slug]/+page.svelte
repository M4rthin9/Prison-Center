<script lang="ts">
  import type { NewsDetail } from '@pc/contract'
  import { Alert, formatDate } from '@pc/ui'
  import { page } from '$app/state'
  import { api } from '$lib/session.svelte.js'

  let item = $state<NewsDetail | null>(null)
  let loading = $state(true)
  let error = $state('')

  $effect(() => {
    const slug = page.params.slug
    if (!slug) return
    loading = true
    api.news
      .get(slug)
      .then((detail) => {
        item = detail
        error = ''
      })
      .catch(() => (error = 'ไม่พบข่าวนี้ อาจถูกลบหรือยังไม่เผยแพร่'))
      .finally(() => (loading = false))
  })
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <a href="/news" class="text-sm text-white/80">← ข่าวสาร</a>
  <h1 class="mt-1 text-xl font-semibold">{item?.title ?? 'ข่าวสาร'}</h1>
  {#if item}
    <p class="text-sm text-white/80">
      {formatDate(item.publishedAt)} · {item.prisonName ?? 'ประกาศส่วนกลาง'}
    </p>
  {/if}
</header>

<main class="space-y-4 p-4">
  {#if error}
    <Alert tone="danger" title={error} />
  {:else if loading}
    <p class="py-16 text-center text-sm text-muted">กำลังโหลด…</p>
  {:else if item}
    {#if item.coverImageUrl}
      <img
        src={item.coverImageUrl}
        alt=""
        class="w-full rounded-[var(--radius-card)] object-cover"
      />
    {/if}

    <!-- Safe to render directly: the API sanitizes on write, so the stored
         value is already the allowlisted subset (modules/news/sanitize.ts). -->
    <article class="news-body text-ink">{@html item.bodyHtml}</article>

    {#if item.authorName}
      <p class="text-xs text-muted">ผู้ประกาศ: {item.authorName}</p>
    {/if}
  {/if}
</main>

<style>
  .news-body :global(p) {
    margin-bottom: 0.75rem;
    line-height: 1.75;
  }
  .news-body :global(h2),
  .news-body :global(h3) {
    margin: 1.25rem 0 0.5rem;
    font-weight: 600;
  }
  .news-body :global(ul),
  .news-body :global(ol) {
    margin: 0 0 0.75rem 1.25rem;
    list-style: disc;
  }
  .news-body :global(ol) {
    list-style: decimal;
  }
  .news-body :global(a) {
    color: var(--color-brand-700);
    text-decoration: underline;
  }
  .news-body :global(img) {
    max-width: 100%;
    border-radius: var(--radius-card);
  }
  .news-body :global(blockquote) {
    border-left: 3px solid var(--color-line);
    padding-left: 0.75rem;
    color: var(--color-muted);
  }
</style>
