<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    tone?: 'info' | 'success' | 'warning' | 'danger'
    title?: string
    children?: Snippet
  }

  let { tone = 'info', title = '', children }: Props = $props()

  const tones: Record<string, string> = {
    info: 'bg-brand-50 text-brand-900 border-brand-200',
    success: 'bg-ok/10 text-ink border-ok/30',
    warning: 'bg-warn/10 text-ink border-warn/40',
    danger: 'bg-danger/10 text-ink border-danger/30'
  }
</script>

<div role={tone === 'danger' ? 'alert' : 'status'} class="rounded-xl border px-4 py-3 {tones[tone]}">
  {#if title}<p class="font-medium">{title}</p>{/if}
  {#if children}<div class="text-sm">{@render children()}</div>{/if}
</div>
