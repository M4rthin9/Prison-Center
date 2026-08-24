<script lang="ts">
  import type { Snippet } from 'svelte'

  interface Props {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
    size?: 'sm' | 'md' | 'lg'
    type?: 'button' | 'submit' | 'reset'
    disabled?: boolean
    loading?: boolean
    full?: boolean
    onclick?: (event: MouseEvent) => void
    children: Snippet
  }

  let {
    variant = 'primary',
    size = 'md',
    type = 'button',
    disabled = false,
    loading = false,
    full = false,
    onclick,
    children
  }: Props = $props()

  const variants: Record<string, string> = {
    primary: 'bg-brand-600 text-white hover:bg-brand-700 disabled:bg-brand-300',
    secondary: 'bg-white text-ink border border-line hover:bg-canvas',
    ghost: 'text-brand-700 hover:bg-brand-50',
    danger: 'bg-danger text-white hover:opacity-90'
  }
  const sizes: Record<string, string> = {
    sm: 'h-9 px-3 text-sm',
    md: 'h-11 px-4',
    lg: 'h-13 px-6 text-lg'
  }
</script>

<button
  {type}
  {onclick}
  disabled={disabled || loading}
  class="inline-flex items-center justify-center gap-2 rounded-xl font-medium transition
         disabled:cursor-not-allowed disabled:opacity-70 {variants[variant]} {sizes[size]}
         {full ? 'w-full' : ''}"
>
  {#if loading}
    <span
      class="size-4 animate-spin rounded-full border-2 border-current border-t-transparent"
      aria-hidden="true"
    ></span>
  {/if}
  {@render children()}
</button>
