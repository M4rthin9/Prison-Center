<script lang="ts">
  interface Props {
    href: string
    label: string
    icon: string
    locked?: boolean
  }

  let { href, label, icon, locked = false }: Props = $props()
</script>

{#if locked}
  <div
    class="flex aspect-4/3 cursor-not-allowed flex-col items-center justify-center gap-2
           rounded-[var(--radius-card)] border border-line bg-surface/60 text-muted"
    aria-disabled="true"
  >
    <span class="text-3xl opacity-40" aria-hidden="true">{icon}</span>
    <span class="text-sm">{label}</span>
    <span class="text-xs">รอการยืนยัน</span>
  </div>
{:else}
  <a
    {href}
    class="flex aspect-4/3 flex-col items-center justify-center gap-2 rounded-[var(--radius-card)]
           border border-line bg-surface shadow-sm transition active:scale-[0.98]"
  >
    <span class="text-3xl" aria-hidden="true">{icon}</span>
    <span class="text-sm font-medium text-ink">{label}</span>
  </a>
{/if}
