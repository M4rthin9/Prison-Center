<script lang="ts">
  import type {
    VisitBookingDetail,
    VisitBookingStatus,
    VisitBookingSummary,
    VisitScheduleDay,
    VisitScheduleGrid,
    VisitSummaryTotals
  } from '@pc/contract'
  import { Alert, Button, Card, formatPhone } from '@pc/ui'
  import { api, session, toFormError } from '$lib/session.svelte.js'

  /* ── the week ──────────────────────────────────────────────────────── */

  const WEEKDAY = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.']
  const STATUS_LABEL: Record<VisitBookingStatus, string> = {
    pending: 'รอยืนยัน',
    confirmed: 'ยืนยันแล้ว',
    checked_in: 'เข้าเยี่ยมแล้ว',
    cancelled: 'ยกเลิก',
    no_show: 'ไม่มาตามนัด'
  }

  /** `YYYY-MM-DD` of the Monday on or before `date`. */
  function mondayOf(date: string): string {
    const d = new Date(`${date}T00:00:00Z`)
    const shift = (d.getUTCDay() + 6) % 7
    return new Date(d.getTime() - shift * 86_400_000).toISOString().slice(0, 10)
  }
  const shiftDate = (date: string, days: number) =>
    new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)
  const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10)
  const dayNo = (date: string) => Number(date.slice(8))
  const weekdayOf = (date: string) => new Date(`${date}T00:00:00Z`).getUTCDay()

  let weekStart = $state(mondayOf(today))
  const weekEnd = $derived(shiftDate(weekStart, 6))

  let grid = $state<VisitScheduleGrid | null>(null)
  let totals = $state<VisitSummaryTotals | null>(null)
  let loading = $state(true)
  let busy = $state(false)
  let message = $state('')
  let tone = $state<'danger' | 'success'>('success')

  const canSchedule = $derived(['super_admin', 'prison_admin'].includes(session.me?.role ?? ''))
  const canOperate = $derived(
    ['super_admin', 'prison_admin', 'zone_staff'].includes(session.me?.role ?? '')
  )

  function say(text: string, kind: 'danger' | 'success' = 'success') {
    tone = kind
    message = text
  }

  /** Cells keyed by round → date, because that is exactly how the grid reads. */
  const byCell = $derived.by(() => {
    const map = new Map<string, VisitScheduleDay[]>()
    for (const cell of grid?.cells ?? []) {
      const key = `${cell.roundId}|${cell.date}`
      map.set(key, [...(map.get(key) ?? []), cell])
    }
    return map
  })

  async function loadGrid() {
    loading = true
    try {
      grid = await api.admin.visits.schedule({ from: weekStart, to: weekEnd })
      totals = await api.admin.visits.summary({ from: weekStart, to: weekEnd })
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void weekStart
    void loadGrid()
  })

  /* ── editing a cell ────────────────────────────────────────────────── */

  let editing = $state<VisitScheduleDay | null>(null)
  let editCapacity = $state(20)
  let editZoneId = $state('')
  let editNote = $state('')

  function openCell(cell: VisitScheduleDay) {
    if (!canSchedule) return
    editing = cell
    editCapacity = cell.capacity
    editZoneId = cell.zoneId
    editNote = cell.note ?? ''
  }

  async function saveCell() {
    if (!editing) return
    busy = true
    try {
      await api.admin.visits.updateDay(editing.id, {
        capacity: editCapacity,
        zoneId: editZoneId !== editing.zoneId ? editZoneId : undefined,
        note: editNote.trim() || null
      })
      say('บันทึกช่องเวลาแล้ว — การแก้ด้วยมือจะไม่ถูกงานสร้างตารางเขียนทับ')
      editing = null
      await loadGrid()
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busy = false
    }
  }

  async function toggleClosed(cell: VisitScheduleDay) {
    if (!canSchedule) return
    busy = true
    try {
      await api.admin.visits.updateDay(cell.id, { isClosed: !cell.isClosed })
      say(cell.isClosed ? 'เปิดรับการเยี่ยมช่องนี้แล้ว' : 'ปิดช่องนี้แล้ว')
      await loadGrid()
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busy = false
    }
  }

  async function removeCell() {
    if (!editing) return
    busy = true
    try {
      await api.admin.visits.deleteDay(editing.id)
      say('ลบช่องเวลาแล้ว')
      editing = null
      await loadGrid()
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busy = false
    }
  }

  /* ── adding a cell ─────────────────────────────────────────────────── */

  let adding = $state<{ date: string; roundId: string } | null>(null)
  let addZoneId = $state('')
  let addCapacity = $state(20)

  function openAdd(date: string, roundId: string) {
    if (!canSchedule) return
    adding = { date, roundId }
    addZoneId = grid?.zones[0]?.id ?? ''
    addCapacity = 20
  }

  async function saveAdd() {
    if (!adding || !addZoneId) return
    busy = true
    try {
      await api.admin.visits.createDay({
        date: adding.date,
        roundId: adding.roundId,
        zoneId: addZoneId,
        capacity: addCapacity
      })
      say('เพิ่มช่องเวลาแล้ว')
      adding = null
      await loadGrid()
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busy = false
    }
  }

  /* ── bulk actions ──────────────────────────────────────────────────── */

  async function generate() {
    busy = true
    try {
      const res = await api.admin.visits.generate({})
      say(
        `สร้างตารางถึง ${res.to} แล้ว — เพิ่มใหม่ ${res.created} ช่อง, ` +
          `ช่องที่มีอยู่แล้ว ${res.skipped} ช่องไม่ถูกแตะ`
      )
      await loadGrid()
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busy = false
    }
  }

  async function closeWeek(isClosed: boolean) {
    busy = true
    try {
      const res = await api.admin.visits.closeDates({
        from: weekStart,
        to: weekEnd,
        isClosed,
        note: isClosed ? 'งดเยี่ยมทั้งสัปดาห์' : undefined
      })
      say(`${isClosed ? 'ปิด' : 'เปิด'}การเยี่ยม ${res.affected} ช่องในสัปดาห์นี้แล้ว`)
      await loadGrid()
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busy = false
    }
  }

  /* ── the gate list ─────────────────────────────────────────────────── */

  let listDate = $state(today)
  let listStatus = $state<VisitBookingStatus | ''>('')
  let listQ = $state('')
  let bookings = $state<VisitBookingSummary[]>([])
  let nextCursor = $state<string | null>(null)
  let open = $state<VisitBookingDetail | null>(null)
  let busyId = $state<string | null>(null)

  async function loadBookings(cursor?: string) {
    try {
      const page = await api.admin.visits.list({
        date: listQ.trim() ? undefined : listDate,
        status: listStatus || undefined,
        q: listQ.trim() || undefined,
        cursor,
        limit: 50
      })
      bookings = cursor ? [...bookings, ...page.items] : page.items
      nextCursor = page.nextCursor
    } catch (err) {
      say(toFormError(err).message, 'danger')
    }
  }

  $effect(() => {
    void listDate
    void listStatus
    const term = listQ
    const timer = setTimeout(() => void loadBookings(), term ? 250 : 0)
    return () => clearTimeout(timer)
  })

  async function act(id: string, status: 'checked_in' | 'confirmed' | 'no_show' | 'cancelled') {
    const reason =
      status === 'cancelled' ? (prompt('เหตุผลที่ยกเลิกการจองนี้') ?? '').trim() : ''
    if (status === 'cancelled' && reason === '') return

    busyId = id
    try {
      const detail = await api.admin.visits.setStatus(id, { status, reason: reason || undefined })
      if (open?.id === id) open = detail
      say(`${detail.bookingNo} → ${STATUS_LABEL[detail.status]}`)
      await Promise.all([loadBookings(), loadGrid()])
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busyId = null
    }
  }
</script>

<div class="space-y-5">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-2xl font-semibold text-ink">ตารางเยี่ยมและการจอง</h1>
      <p class="text-muted">
        รอบอยู่แนวตั้ง วันที่อยู่แนวนอน — คลิกช่องเพื่อแก้ไข การแก้ด้วยมือมีผลถาวร · {session.scopeLabel}
      </p>
    </div>
    {#if canSchedule}
      <div class="flex flex-wrap gap-2">
        <Button size="sm" loading={busy} onclick={generate}>สร้างตารางล่วงหน้าจากแม่แบบ</Button>
        <Button size="sm" variant="secondary" onclick={() => closeWeek(true)}>งดเยี่ยมทั้งสัปดาห์</Button>
        <Button size="sm" variant="ghost" onclick={() => closeWeek(false)}>เปิดทั้งสัปดาห์</Button>
        <a class="inline-flex h-9 items-center rounded-lg px-3 text-sm text-brand-700 hover:bg-brand-50" href="/visits/rounds">
          รอบเยี่ยมและแม่แบบ
        </a>
      </div>
    {/if}
  </div>

  {#if message}
    <Alert {tone} title={message} />
  {/if}

  {#if totals}
    <div class="grid gap-3 sm:grid-cols-4">
      {#each [['จองในสัปดาห์นี้', String(totals.bookedCount), 'ที่นั่ง'], ['เข้าเยี่ยมแล้ว', String(totals.checkedInCount), 'ราย'], ['ไม่มาตามนัด', String(totals.noShowCount), 'ราย'], ['ใช้ความจุ', `${Math.round(totals.utilisation * 100)}%`, `จาก ${totals.capacityTotal} ที่นั่ง`]] as [label, value, hint] (label)}
        <div class="rounded-xl border border-line bg-surface px-4 py-3">
          <p class="text-sm text-muted">{label}</p>
          <p class="text-2xl font-semibold text-ink">{value}</p>
          <p class="text-xs text-muted">{hint}</p>
        </div>
      {/each}
    </div>
  {/if}

  <Card padded={false}>
    {#snippet actions()}
      <div class="flex items-center gap-2">
        <Button size="sm" variant="ghost" onclick={() => (weekStart = shiftDate(weekStart, -7))}>
          ← สัปดาห์ก่อน
        </Button>
        <Button size="sm" variant="ghost" onclick={() => (weekStart = mondayOf(today))}>
          สัปดาห์นี้
        </Button>
        <Button size="sm" variant="ghost" onclick={() => (weekStart = shiftDate(weekStart, 7))}>
          สัปดาห์ถัดไป →
        </Button>
      </div>
    {/snippet}

    <div class="overflow-x-auto">
      <table class="w-full min-w-[56rem] border-collapse">
        <thead>
          <tr>
            <th class="w-40 border-b border-line px-3 py-2 text-left text-sm text-muted">รอบ</th>
            {#each grid?.dates ?? [] as date (date)}
              <th
                class="border-b border-line px-2 py-2 text-center text-sm
                       {date === today ? 'bg-brand-50 text-brand-800' : 'text-muted'}"
              >
                <div class="font-medium text-ink">{WEEKDAY[weekdayOf(date)]} {dayNo(date)}</div>
                <div class="text-xs">{date}</div>
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each grid?.rounds ?? [] as round (round.id)}
            <tr class="align-top">
              <th class="border-b border-line px-3 py-2 text-left">
                <p class="font-medium text-ink">{round.label}</p>
                <p class="text-xs text-muted">
                  {round.startTime}–{round.endTime} · {round.session === 'morning' ? 'เช้า' : 'บ่าย'}
                </p>
              </th>
              {#each grid?.dates ?? [] as date (date)}
                {@const cells = byCell.get(`${round.id}|${date}`) ?? []}
                <td class="border-b border-line px-1.5 py-1.5">
                  <div class="space-y-1">
                    {#each cells as cell (cell.id)}
                      <button
                        type="button"
                        onclick={() => openCell(cell)}
                        oncontextmenu={(e) => {
                          e.preventDefault()
                          void toggleClosed(cell)
                        }}
                        title="คลิกเพื่อแก้ไข · คลิกขวาเพื่อปิด/เปิดช่องนี้"
                        class="w-full rounded-lg border px-2 py-1 text-left text-xs transition
                               {cell.isClosed
                          ? 'border-dashed border-line bg-canvas text-muted line-through'
                          : cell.bookedCount >= cell.capacity
                            ? 'border-danger/40 bg-danger/10 text-ink'
                            : 'border-line bg-surface text-ink hover:border-brand-400 hover:bg-brand-50'}"
                      >
                        <span class="block truncate font-medium">{cell.zoneName}</span>
                        <span class="text-muted">
                          {cell.bookedCount}/{cell.capacity}{cell.source === 'manual' ? ' ·✎' : ''}
                        </span>
                      </button>
                    {/each}
                    {#if canSchedule}
                      <button
                        type="button"
                        onclick={() => openAdd(date, round.id)}
                        class="w-full rounded-lg border border-dashed border-line px-2 py-1 text-xs text-muted hover:border-brand-400 hover:text-brand-700"
                      >
                        + เพิ่มแดน
                      </button>
                    {/if}
                  </div>
                </td>
              {/each}
            </tr>
          {:else}
            <tr>
              <td colspan="8" class="py-10 text-center text-muted">
                {loading ? 'กำลังโหลด…' : 'ยังไม่ได้กำหนดรอบเยี่ยมของเรือนจำนี้'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Card>

  <!-- ── the gate list ───────────────────────────────────────────────── -->

  <div class="flex flex-wrap items-center gap-2">
    <input
      type="date"
      bind:value={listDate}
      class="rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink"
    />
    {#each [['', 'ทั้งหมด'], ['confirmed', 'ยืนยันแล้ว'], ['checked_in', 'เข้าเยี่ยมแล้ว'], ['pending', 'รอยืนยัน'], ['cancelled', 'ยกเลิก'], ['no_show', 'ไม่มาตามนัด']] as [key, label] (label)}
      <button
        type="button"
        onclick={() => (listStatus = key as VisitBookingStatus | '')}
        class="rounded-full px-4 py-1.5 text-sm transition
               {listStatus === key ? 'bg-brand-600 text-white' : 'border border-line bg-surface text-ink'}"
      >
        {label}
      </button>
    {/each}
    <input
      type="search"
      bind:value={listQ}
      placeholder="เลขที่จอง / ผู้ต้องขัง / ผู้เยี่ยม (ค้นทุกวัน)"
      class="ml-auto w-80 rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink"
    />
  </div>

  <Card padded={false}>
    <div class="overflow-x-auto">
      <table class="admin-table">
        <thead>
          <tr>
            <th>เลขที่จอง</th>
            <th>วัน / รอบ</th>
            <th>ผู้ต้องขัง</th>
            <th>ผู้เยี่ยม</th>
            <th>สถานะ</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each bookings as row (row.id)}
            <tr>
              <td class="font-mono text-sm">{row.bookingNo}</td>
              <td>
                <p class="text-ink">{row.visitDate}</p>
                <p class="text-sm text-muted">
                  {row.roundLabel} · {row.startTime}–{row.endTime}
                </p>
              </td>
              <td>
                <p class="font-medium text-ink">{row.inmateName}</p>
                <p class="text-sm text-muted">
                  {row.inmateCode}{row.zoneName ? ` · ${row.zoneName}` : ''}
                </p>
              </td>
              <td>
                <p class="text-ink">{row.visitorName} ({row.visitorCount})</p>
                <p class="text-sm text-muted">{formatPhone(row.contactPhone)}</p>
              </td>
              <td>{STATUS_LABEL[row.status]}</td>
              <td class="text-right whitespace-nowrap">
                {#if canOperate && (row.status === 'confirmed' || row.status === 'pending')}
                  <Button size="sm" loading={busyId === row.id} onclick={() => act(row.id, 'checked_in')}>
                    เช็คอิน
                  </Button>
                {/if}
                <Button
                  size="sm"
                  variant="ghost"
                  onclick={async () => (open = await api.admin.visits.get(row.id))}
                >
                  เปิด
                </Button>
              </td>
            </tr>
          {:else}
            <tr>
              <td colspan="6" class="py-8 text-center text-muted">ไม่มีการจองในเงื่อนไขนี้</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Card>

  {#if nextCursor}
    <div class="text-center">
      <Button variant="ghost" onclick={() => void loadBookings(nextCursor ?? undefined)}>
        โหลดเพิ่ม
      </Button>
    </div>
  {/if}
</div>

<!-- ── cell editor ───────────────────────────────────────────────────── -->

{#if editing}
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
    <div class="w-full max-w-md rounded-2xl bg-surface p-5 shadow-lg">
      <h2 class="text-lg font-semibold text-ink">
        {editing.roundLabel} · {editing.date}
      </h2>
      <p class="text-sm text-muted">
        {editing.startTime}–{editing.endTime} · จองแล้ว {editing.bookedCount} ที่นั่ง
        {editing.source === 'manual' ? '· แก้ด้วยมือ' : '· มาจากแม่แบบ'}
      </p>

      <div class="mt-4 space-y-3">
        <label class="block text-sm">
          <span class="text-muted">แดน</span>
          <select
            bind:value={editZoneId}
            disabled={editing.bookedCount > 0}
            class="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 text-ink disabled:bg-canvas"
          >
            {#each grid?.zones ?? [] as zone (zone.id)}
              <option value={zone.id}>{zone.name}</option>
            {/each}
          </select>
          {#if editing.bookedCount > 0}
            <span class="text-xs text-muted">มีการจองแล้ว จึงเปลี่ยนแดนไม่ได้</span>
          {/if}
        </label>

        <label class="block text-sm">
          <span class="text-muted">ความจุ (ที่นั่ง)</span>
          <input
            type="number"
            min={editing.bookedCount}
            bind:value={editCapacity}
            class="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 text-ink"
          />
        </label>

        <label class="block text-sm">
          <span class="text-muted">หมายเหตุ</span>
          <input
            type="text"
            bind:value={editNote}
            placeholder="เช่น งดเยี่ยมวันหยุดนักขัตฤกษ์"
            class="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 text-ink"
          />
        </label>
      </div>

      <div class="mt-5 flex flex-wrap gap-2">
        <Button loading={busy} onclick={saveCell}>บันทึก</Button>
        <Button variant="secondary" onclick={() => toggleClosed(editing!)}>
          {editing.isClosed ? 'เปิดรับการเยี่ยม' : 'ปิดช่องนี้'}
        </Button>
        {#if editing.bookedCount === 0}
          <Button variant="ghost" onclick={removeCell}>ลบช่อง</Button>
        {/if}
        <Button variant="ghost" onclick={() => (editing = null)}>ปิด</Button>
      </div>
    </div>
  </div>
{/if}

<!-- ── add cell ──────────────────────────────────────────────────────── -->

{#if adding}
  <div class="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-4">
    <div class="w-full max-w-md rounded-2xl bg-surface p-5 shadow-lg">
      <h2 class="text-lg font-semibold text-ink">เพิ่มช่องเวลาเยี่ยม</h2>
      <p class="text-sm text-muted">{adding.date}</p>

      <div class="mt-4 space-y-3">
        <label class="block text-sm">
          <span class="text-muted">แดน</span>
          <select
            bind:value={addZoneId}
            class="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 text-ink"
          >
            {#each grid?.zones ?? [] as zone (zone.id)}
              <option value={zone.id}>{zone.name}</option>
            {/each}
          </select>
        </label>
        <label class="block text-sm">
          <span class="text-muted">ความจุ (ที่นั่ง)</span>
          <input
            type="number"
            min="0"
            bind:value={addCapacity}
            class="mt-1 w-full rounded-xl border border-line bg-white px-3 py-2 text-ink"
          />
        </label>
      </div>

      <div class="mt-5 flex gap-2">
        <Button loading={busy} onclick={saveAdd}>เพิ่ม</Button>
        <Button variant="ghost" onclick={() => (adding = null)}>ยกเลิก</Button>
      </div>
    </div>
  </div>
{/if}

<!-- ── booking drawer ────────────────────────────────────────────────── -->

{#if open}
  <div class="fixed inset-0 z-40 flex">
    <button type="button" class="flex-1 cursor-default bg-black/30" aria-label="ปิด" onclick={() => (open = null)}
    ></button>
    <aside class="w-[28rem] max-w-full overflow-y-auto border-l border-line bg-surface p-5">
      <div class="flex items-start justify-between gap-3">
        <div>
          <p class="font-mono text-sm text-muted">{open.bookingNo}</p>
          <h2 class="text-xl font-semibold text-ink">{open.inmateName}</h2>
          <p class="text-sm text-muted">{STATUS_LABEL[open.status]}</p>
        </div>
        <Button size="sm" variant="ghost" onclick={() => (open = null)}>ปิด</Button>
      </div>

      <dl class="mt-4 space-y-2 border-t border-line pt-4 text-sm">
        <div class="flex justify-between gap-4">
          <dt class="text-muted">วันเยี่ยม</dt>
          <dd class="text-ink">{open.visitDate}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">รอบ</dt>
          <dd class="text-ink">{open.roundLabel} · {open.startTime}–{open.endTime}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">แดน</dt>
          <dd class="text-ink">{open.zoneName ?? '—'}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">ผู้ต้องขัง</dt>
          <dd class="text-ink">{open.inmateName} ({open.inmateCode})</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">ผู้เยี่ยม</dt>
          <dd class="text-ink">{open.visitorName} · {open.visitorCount} คน</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">ติดต่อ</dt>
          <dd class="text-ink">{formatPhone(open.contactPhone)}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">บัญชีญาติ</dt>
          <dd class="text-ink">{open.customerName} · {formatPhone(open.customerPhone)}</dd>
        </div>
      </dl>

      {#if open.note}
        <p class="mt-3 rounded-xl bg-canvas px-3 py-2 text-sm text-ink">{open.note}</p>
      {/if}
      {#if open.cancelledReason}
        <div class="mt-3"><Alert tone="danger" title={open.cancelledReason} /></div>
      {/if}

      {#if canOperate && (open.status === 'pending' || open.status === 'confirmed')}
        <div class="mt-4 flex flex-wrap gap-2 border-t border-line pt-4">
          {#if open.status === 'pending'}
            <Button loading={busyId === open.id} onclick={() => act(open!.id, 'confirmed')}>
              ยืนยันการจอง
            </Button>
          {/if}
          <Button loading={busyId === open.id} onclick={() => act(open!.id, 'checked_in')}>
            เช็คอิน
          </Button>
          <Button variant="secondary" onclick={() => act(open!.id, 'no_show')}>ไม่มาตามนัด</Button>
          <Button variant="ghost" onclick={() => act(open!.id, 'cancelled')}>ยกเลิก</Button>
        </div>
      {/if}
    </aside>
  </div>
{/if}
