<script lang="ts">
  import type {
    PublicSettings,
    VisitAvailability,
    VisitBookingStatus,
    VisitBookingSummary,
    VisitSlot
  } from '@pc/contract'
  import { Alert, Button, Card } from '@pc/ui'
  import { goto } from '$app/navigation'
  import { api, session, toFormError } from '$lib/session.svelte.js'

  const STATUS_LABEL: Record<VisitBookingStatus, string> = {
    pending: 'รอเจ้าหน้าที่ยืนยัน',
    confirmed: 'ยืนยันแล้ว',
    checked_in: 'เข้าเยี่ยมแล้ว',
    cancelled: 'ยกเลิกแล้ว',
    no_show: 'ไม่ได้มาตามนัด'
  }
  const STATUS_TONE: Record<VisitBookingStatus, string> = {
    pending: 'bg-warn/15 text-ink',
    confirmed: 'bg-ok/15 text-ink',
    checked_in: 'bg-brand-50 text-brand-800',
    cancelled: 'bg-canvas text-muted',
    no_show: 'bg-danger/10 text-danger'
  }
  const WEEKDAY = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์']

  function thaiDate(date: string) {
    const d = new Date(`${date}T00:00:00Z`)
    return `${WEEKDAY[d.getUTCDay()]} ${d.getUTCDate()}/${d.getUTCMonth() + 1}`
  }

  let inmateId = $state('')
  let avail = $state<VisitAvailability | null>(null)
  let bookings = $state<VisitBookingSummary[]>([])
  let settings = $state<PublicSettings | null>(null)
  let loading = $state(true)
  let working = $state(false)
  let error = $state('')

  /** The chosen slot, and the visitor details that go on the gate sheet. */
  let picked = $state<VisitSlot | null>(null)
  let visitorName = $state('')
  let contactPhone = $state('')
  let visitorCount = $state(1)
  let note = $state('')

  const inmates = $derived(session.verifiedInmates)
  const maxVisitors = $derived(settings?.visit?.maxVisitorsPerBooking ?? 3)

  /** Slots grouped by date — the family thinks in days, not in rows. */
  const byDate = $derived.by(() => {
    const map = new Map<string, VisitSlot[]>()
    for (const slot of avail?.slots ?? []) {
      map.set(slot.date, [...(map.get(slot.date) ?? []), slot])
    }
    return [...map.entries()].filter(([, slots]) => slots.some((s) => !s.isClosed))
  })

  async function load() {
    loading = true
    try {
      const [b, s] = await Promise.all([api.visits.list({ limit: 20 }), api.settings.public()])
      bookings = b.items
      settings = s
      visitorName ||= session.me?.fullName ?? ''
      contactPhone ||= session.me?.phone ?? ''
      inmateId ||= inmates[0]?.inmateId ?? ''
    } catch (err) {
      error = toFormError(err).message
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void load()
  })

  // Availability is re-read whenever the inmate changes: the calendar belongs
  // to their แดน, not to the account.
  $effect(() => {
    const id = inmateId
    if (!id) return
    void (async () => {
      try {
        avail = await api.visits.availability(id)
        error = ''
      } catch (err) {
        avail = null
        error = toFormError(err).message
      }
    })()
  })

  async function book() {
    if (!picked) return
    working = true
    error = ''
    try {
      const booking = await api.visits.book({
        inmateId,
        scheduleDayId: picked.scheduleDayId,
        visitorName: visitorName.trim(),
        contactPhone: contactPhone.trim(),
        visitorCount,
        note: note.trim() || undefined
      })
      picked = null
      note = ''
      await goto(`/visits/${booking.id}`)
    } catch (err) {
      error = toFormError(err).message
      // The slot may have filled while the form was open — re-read it.
      if (inmateId) avail = await api.visits.availability(inmateId).catch(() => avail)
    } finally {
      working = false
    }
  }
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <h1 class="text-xl font-semibold">จองเยี่ยมผู้ต้องขัง</h1>
  <p class="text-sm text-brand-100">เลือกวันและรอบตามตารางที่เรือนจำกำหนด</p>
</header>

<main class="space-y-4 p-4 pb-24">
  {#if error}<Alert tone="danger" title={error} />{/if}

  {#if !session.canTransact}
    <Card>
      <p class="text-ink">บัญชีของคุณยังไม่ได้รับการยืนยันความสัมพันธ์กับผู้ต้องขัง</p>
      <p class="mt-1 text-sm text-muted">
        กรุณาเพิ่มผู้ต้องขังในหน้าบัญชีและรอเจ้าหน้าที่ยืนยันก่อนจึงจะจองเยี่ยมได้
      </p>
      <a class="mt-3 inline-block text-brand-700" href="/profile">ไปที่หน้าบัญชี</a>
    </Card>
  {:else}
    <Card title="เยี่ยมใคร">
      <select
        bind:value={inmateId}
        class="w-full rounded-xl border border-line bg-white px-3 py-3 text-ink"
      >
        {#each inmates as inmate (inmate.inmateId)}
          <option value={inmate.inmateId}>
            {inmate.fullName} ({inmate.inmateCode}){inmate.zoneName ? ` · ${inmate.zoneName}` : ''}
          </option>
        {/each}
      </select>
      {#if avail}
        <p class="mt-2 text-sm text-muted">
          เยี่ยมที่ {avail.zoneName ?? 'ยังไม่ระบุแดน'} · ปิดรับจองก่อนเวลาเยี่ยม {avail.cutoffHours} ชั่วโมง
        </p>
      {/if}
    </Card>

    <Card title="เลือกวันและรอบ" subtitle={avail ? `${avail.from} ถึง ${avail.to}` : ''}>
      {#if loading}
        <p class="text-muted">กำลังโหลด…</p>
      {:else if byDate.length === 0}
        <p class="text-muted">
          ยังไม่มีรอบเยี่ยมที่เปิดให้จองสำหรับแดนของผู้ต้องขังรายนี้ในช่วงนี้
        </p>
      {:else}
        <div class="space-y-4">
          {#each byDate as [date, slots] (date)}
            <div>
              <p class="text-sm font-medium text-ink">{thaiDate(date)} · {date}</p>
              <div class="mt-2 grid grid-cols-2 gap-2">
                {#each slots as slot (slot.scheduleDayId)}
                  <button
                    type="button"
                    disabled={!slot.isBookable}
                    onclick={() => (picked = slot)}
                    class="rounded-xl border px-3 py-2 text-left text-sm transition
                           {picked?.scheduleDayId === slot.scheduleDayId
                      ? 'border-brand-600 bg-brand-50'
                      : slot.isBookable
                        ? 'border-line bg-surface'
                        : 'border-line bg-canvas text-muted'}"
                  >
                    <span class="block font-medium text-ink">{slot.roundLabel}</span>
                    <span class="block">{slot.startTime}–{slot.endTime}</span>
                    <span class="block text-xs">
                      {#if slot.isClosed}
                        งดเยี่ยม
                      {:else if slot.available === 0}
                        เต็มแล้ว
                      {:else if !slot.isBookable}
                        เลยเวลารับจอง
                      {:else}
                        ว่าง {slot.available} ที่
                      {/if}
                    </span>
                    {#if slot.note}
                      <span class="mt-0.5 block text-xs text-muted">{slot.note}</span>
                    {/if}
                  </button>
                {/each}
              </div>
            </div>
          {/each}
        </div>
      {/if}
    </Card>

    {#if picked}
      <Card title="ผู้เข้าเยี่ยม" subtitle="ชื่อที่แจ้งไว้ต้องตรงกับบัตรประชาชนที่นำมาแสดงหน้าประตู">
        <div class="space-y-3">
          <label class="block text-sm">
            <span class="text-muted">ชื่อ–นามสกุลผู้เยี่ยม</span>
            <input
              type="text"
              bind:value={visitorName}
              class="mt-1 w-full rounded-xl border border-line bg-white px-3 py-3 text-ink"
            />
          </label>
          <label class="block text-sm">
            <span class="text-muted">เบอร์ติดต่อ</span>
            <input
              type="tel"
              inputmode="tel"
              bind:value={contactPhone}
              class="mt-1 w-full rounded-xl border border-line bg-white px-3 py-3 text-ink"
            />
          </label>
          <label class="block text-sm">
            <span class="text-muted">จำนวนผู้เยี่ยม (สูงสุด {maxVisitors} คน)</span>
            <input
              type="number"
              min="1"
              max={maxVisitors}
              bind:value={visitorCount}
              class="mt-1 w-full rounded-xl border border-line bg-white px-3 py-3 text-ink"
            />
          </label>
          <label class="block text-sm">
            <span class="text-muted">หมายเหตุถึงเจ้าหน้าที่ (ถ้ามี)</span>
            <input
              type="text"
              bind:value={note}
              class="mt-1 w-full rounded-xl border border-line bg-white px-3 py-3 text-ink"
            />
          </label>
        </div>

        <div class="mt-4 rounded-xl bg-canvas px-3 py-2 text-sm text-ink">
          {thaiDate(picked.date)} {picked.date} · {picked.roundLabel}
          {picked.startTime}–{picked.endTime} · {picked.zoneName}
        </div>

        <div class="mt-4">
          <Button
            full
            loading={working}
            disabled={visitorName.trim().length < 2 || contactPhone.trim().length < 9}
            onclick={book}
          >
            ยืนยันการจอง
          </Button>
        </div>
      </Card>
    {/if}

    <Card title="การจองของฉัน" padded={false}>
      <ul class="divide-y divide-line">
        {#each bookings as booking (booking.id)}
          <li>
            <a class="block px-5 py-3" href={`/visits/${booking.id}`}>
              <div class="flex items-start justify-between gap-3">
                <div>
                  <p class="font-medium text-ink">
                    {thaiDate(booking.visitDate)} · {booking.roundLabel}
                  </p>
                  <p class="text-sm text-muted">
                    {booking.inmateName} · {booking.startTime}–{booking.endTime}
                  </p>
                  <p class="font-mono text-xs text-muted">{booking.bookingNo}</p>
                </div>
                <span class="rounded-full px-2.5 py-1 text-xs {STATUS_TONE[booking.status]}">
                  {STATUS_LABEL[booking.status]}
                </span>
              </div>
            </a>
          </li>
        {:else}
          <li class="px-5 py-8 text-center text-muted">ยังไม่มีการจองเยี่ยม</li>
        {/each}
      </ul>
    </Card>
  {/if}
</main>
