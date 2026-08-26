<script lang="ts">
  import type { VisitBookingDetail, VisitBookingStatus } from '@pc/contract'
  import { Alert, Button, Card, formatDateTime, formatPhone } from '@pc/ui'
  import { page } from '$app/state'
  import { api, toFormError } from '$lib/session.svelte.js'

  const STATUS_LABEL: Record<VisitBookingStatus, string> = {
    pending: 'รอเจ้าหน้าที่ยืนยัน',
    confirmed: 'ยืนยันแล้ว',
    checked_in: 'เข้าเยี่ยมแล้ว',
    cancelled: 'ยกเลิกแล้ว',
    no_show: 'ไม่ได้มาตามนัด'
  }

  let booking = $state<VisitBookingDetail | null>(null)
  let error = $state('')
  let working = $state(false)

  $effect(() => {
    const id = page.params.id
    void (async () => {
      try {
        booking = await api.visits.get(id!)
      } catch (err) {
        error = toFormError(err).message
      }
    })()
  })

  async function cancel() {
    if (!booking) return
    working = true
    error = ''
    try {
      booking = await api.visits.cancel(booking.id)
    } catch (err) {
      error = toFormError(err).message
    } finally {
      working = false
    }
  }
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <a class="text-sm text-brand-100" href="/visits">← การจองเยี่ยม</a>
  <h1 class="mt-1 text-xl font-semibold">
    {booking ? booking.bookingNo : 'กำลังโหลด…'}
  </h1>
  {#if booking}
    <p class="text-sm text-brand-100">{STATUS_LABEL[booking.status]}</p>
  {/if}
</header>

<main class="space-y-4 p-4 pb-24">
  {#if error}<Alert tone="danger" title={error} />{/if}

  {#if booking}
    <Card title="รายละเอียดการเยี่ยม">
      <dl class="space-y-2 text-sm">
        <div class="flex justify-between gap-4">
          <dt class="text-muted">วันเยี่ยม</dt>
          <dd class="text-ink">{booking.visitDate}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">รอบ</dt>
          <dd class="text-ink">
            {booking.roundLabel} · {booking.startTime}–{booking.endTime}
          </dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">เรือนจำ / แดน</dt>
          <dd class="text-right text-ink">
            {booking.prisonName}{booking.zoneName ? ` · ${booking.zoneName}` : ''}
          </dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">ผู้ต้องขัง</dt>
          <dd class="text-ink">{booking.inmateName} ({booking.inmateCode})</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">ผู้เยี่ยม</dt>
          <dd class="text-ink">{booking.visitorName} · {booking.visitorCount} คน</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">เบอร์ติดต่อ</dt>
          <dd class="text-ink">{formatPhone(booking.contactPhone)}</dd>
        </div>
        {#if booking.checkedInAt}
          <div class="flex justify-between gap-4">
            <dt class="text-muted">เช็คอินเมื่อ</dt>
            <dd class="text-ink">{formatDateTime(booking.checkedInAt)}</dd>
          </div>
        {/if}
      </dl>

      {#if booking.note}
        <p class="mt-3 rounded-xl bg-canvas px-3 py-2 text-sm text-ink">{booking.note}</p>
      {/if}
      {#if booking.cancelledReason}
        <div class="mt-3"><Alert tone="danger" title={booking.cancelledReason} /></div>
      {/if}
    </Card>

    <Card title="เตรียมตัวก่อนเข้าเยี่ยม">
      <ul class="list-disc space-y-1 pl-5 text-sm text-ink">
        <li>นำบัตรประชาชนของผู้เยี่ยมทุกคนมาแสดงที่จุดลงทะเบียน</li>
        <li>มาถึงก่อนเวลาเริ่มรอบอย่างน้อย 30 นาที</li>
        <li>แจ้งเลขที่จอง <span class="font-mono">{booking.bookingNo}</span> กับเจ้าหน้าที่</li>
      </ul>
    </Card>

    {#if booking.canCancel}
      <Button full variant="ghost" loading={working} onclick={cancel}>ยกเลิกการจอง</Button>
    {:else if booking.status === 'confirmed' || booking.status === 'pending'}
      <p class="text-center text-sm text-muted">
        เลยกำหนดยกเลิกแล้ว หากไปไม่ได้ กรุณาติดต่อเจ้าหน้าที่เรือนจำ
      </p>
    {/if}
  {/if}
</main>
