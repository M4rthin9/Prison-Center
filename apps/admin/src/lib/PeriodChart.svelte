<script lang="ts">
  import type { DashboardSeriesPoint } from '@pc/contract'

  interface Props {
    points: DashboardSeriesPoint[]
    /** Which field to plot, and how to label a value in the tooltip. */
    metric: keyof Omit<DashboardSeriesPoint, 'date'>
    label: string
    format?: (value: number) => string
  }

  let { points, metric, label, format = (v: number) => String(v) }: Props = $props()

  const values = $derived(points.map((p) => Number(p[metric] ?? 0)))
  const max = $derived(Math.max(1, ...values))
  const total = $derived(values.reduce((a, b) => a + b, 0))
  // Bars, not a line: these are daily counts, and a line implies a continuum
  // between two days that does not exist.
  const barWidth = $derived(100 / Math.max(points.length, 1))

  const dayLabel = (date: string) => date.slice(8)
  /** Only the first, middle and last day get a tick — 31 labels is noise. */
  const ticks = $derived(
    points.length === 0
      ? []
      : [0, Math.floor((points.length - 1) / 2), points.length - 1]
          .filter((v, i, arr) => arr.indexOf(v) === i)
          .map((i) => ({ i, date: points[i]!.date }))
  )
</script>

<div>
  <div class="flex items-baseline justify-between">
    <p class="text-sm text-muted">{label}</p>
    <p class="text-sm font-medium text-ink">{format(total)}</p>
  </div>

  {#if points.length === 0}
    <p class="py-6 text-center text-sm text-muted">ไม่มีข้อมูลในช่วงนี้</p>
  {:else}
    <svg
      class="mt-2 h-24 w-full"
      viewBox="0 0 100 40"
      preserveAspectRatio="none"
      role="img"
      aria-label="{label} รายวัน"
    >
      {#each points as point, i (point.date)}
        {@const value = Number(point[metric] ?? 0)}
        {@const height = (value / max) * 36}
        <rect
          x={i * barWidth + barWidth * 0.15}
          y={38 - height}
          width={barWidth * 0.7}
          height={Math.max(height, value > 0 ? 0.8 : 0)}
          rx="0.4"
          class="fill-brand-500"
        >
          <title>{point.date} · {format(value)}</title>
        </rect>
      {/each}
      <line x1="0" y1="38.4" x2="100" y2="38.4" class="stroke-line" stroke-width="0.3" />
    </svg>

    <div class="flex justify-between text-[11px] text-muted">
      {#each ticks as tick (tick.i)}
        <span>{dayLabel(tick.date)}</span>
      {/each}
    </div>
  {/if}
</div>
