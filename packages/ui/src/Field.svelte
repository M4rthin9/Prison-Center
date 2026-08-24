<script lang="ts">
  interface Props {
    label: string
    value: string
    type?: 'text' | 'password' | 'tel' | 'email' | 'number'
    placeholder?: string
    /** Field-level messages from the API error envelope. */
    errors?: string[]
    hint?: string
    required?: boolean
    autocomplete?: AutoFill
    inputmode?: 'text' | 'tel' | 'numeric' | 'email'
    disabled?: boolean
  }

  let {
    label,
    value = $bindable(),
    type = 'text',
    placeholder = '',
    errors = [],
    hint = '',
    required = false,
    autocomplete,
    inputmode,
    disabled = false
  }: Props = $props()

  const id = `f-${Math.random().toString(36).slice(2, 9)}`
  const invalid = $derived(errors.length > 0)
</script>

<div class="space-y-1.5">
  <label for={id} class="block text-sm font-medium text-ink">
    {label}
    {#if required}<span class="text-danger">*</span>{/if}
  </label>

  <input
    {id}
    {type}
    {placeholder}
    {required}
    {disabled}
    {autocomplete}
    {inputmode}
    bind:value
    aria-invalid={invalid}
    aria-describedby={invalid ? `${id}-err` : hint ? `${id}-hint` : undefined}
    class="w-full rounded-xl border bg-white px-3.5 py-2.5 text-ink transition
           placeholder:text-muted/60 disabled:bg-canvas
           {invalid ? 'border-danger' : 'border-line focus:border-brand-400'}"
  />

  {#if invalid}
    <p id="{id}-err" class="text-sm text-danger">{errors.join(' · ')}</p>
  {:else if hint}
    <p id="{id}-hint" class="text-sm text-muted">{hint}</p>
  {/if}
</div>
