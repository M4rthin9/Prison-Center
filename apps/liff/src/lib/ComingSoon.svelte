<script lang="ts">
  interface Props {
    title: string
    phase: string
    detail: string
  }

  let { title, phase, detail }: Props = $props()
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <h1 class="text-xl font-semibold">{title}</h1>
</header>

<main class="p-4">
  <div class="rounded-[var(--radius-card)] border border-line bg-surface p-6 text-center">
    <p class="text-4xl" aria-hidden="true">🚧</p>
    <p class="mt-3 font-medium text-ink">อยู่ระหว่างการพัฒนา — {phase}</p>
    <p class="mt-1 text-sm text-muted">{detail}</p>
    <a class="mt-5 inline-block text-brand-700" href="/">กลับหน้าแรก</a>
  </div>
</main>
