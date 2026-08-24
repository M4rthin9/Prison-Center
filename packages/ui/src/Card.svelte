<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    title?: string
    subtitle?: string
    actions?: Snippet
    children: Snippet
    padded?: boolean
  }

  let { title = '', subtitle = '', actions, children, padded = true }: Props = $props()
</script>

<section class="rounded-[var(--radius-card)] border border-line bg-surface shadow-sm">
  {#if title || actions}
    <header class="flex items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div>
        {#if title}<h2 class="font-semibold text-ink">{title}</h2>{/if}
        {#if subtitle}<p class="text-sm text-muted">{subtitle}</p>{/if}
      </div>
      {#if actions}<div class="shrink-0">{@render actions()}</div>{/if}
    </header>
  {/if}
  <div class={padded ? 'px-5 py-4' : ''}>{@render children()}</div>
</section>
