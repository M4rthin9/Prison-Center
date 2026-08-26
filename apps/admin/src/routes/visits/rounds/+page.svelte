<script lang="ts">
  import type { VisitRound, VisitSession, VisitTemplateCell } from '@pc/contract'
  import { Alert, Button, Card } from '@pc/ui'
  import { api, session, toFormError } from '$lib/session.svelte.js'

  const WEEKDAYS = [
    { weekday: 1, label: 'จันทร์' },
    { weekday: 2, label: 'อังคาร' },
    { weekday: 3, label: 'พุธ' },
    { weekday: 4, label: 'พฤหัสบดี' },
    { weekday: 5, label: 'ศุกร์' },
    { weekday: 6, label: 'เสาร์' },
    { weekday: 0, label: 'อาทิตย์' }
  ]

  let rounds = $state<VisitRound[]>([])
  let templates = $state<VisitTemplateCell[]>([])
  let zones = $state<{ id: string; name: string }[]>([])
  let busy = $state(false)
  let message = $state('')
  let tone = $state<'danger' | 'success'>('success')

  const canSchedule = $derived(['super_admin', 'prison_admin'].includes(session.me?.role ?? ''))

  function say(text: string, kind: 'danger' | 'success' = 'success') {
    tone = kind
    message = text
  }

  async function load() {
    try {
      const [r, t, grid] = await Promise.all([
        api.admin.visits.rounds({ includeInactive: true }),
        api.admin.visits.templates(),
        api.admin.visits.schedule()
      ])
      rounds = r.items
      templates = t.items
      zones = grid.zones
    } catch (err) {
      say(toFormError(err).message, 'danger')
    }
  }

  $effect(() => {
    void load()
  })

  /** The template cell for one (weekday, round), or undefined if the grid is empty there. */
  const cellFor = (weekday: number, roundId: string) =>
    templates.find((t) => t.weekday === weekday && t.roundId === roundId)

  /* ── rounds ────────────────────────────────────────────────────────── */

  let newRound = $state({
    roundNo: 1,
    label: '',
    session: 'morning' as VisitSession,
    startTime: '09:00',
    endTime: '09:40'
  })

  async function addRound() {
    busy = true
    try {
      await api.admin.visits.createRound({ ...newRound })
      say(`เพิ่ม ${newRound.label} แล้ว`)
      newRound = {
        roundNo: newRound.roundNo + 1,
        label: '',
        session: newRound.session,
        startTime: newRound.endTime,
        endTime: newRound.endTime
      }
      await load()
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busy = false
    }
  }

  async function toggleRound(round: VisitRound) {
    busy = true
    try {
      await api.admin.visits.updateRound(round.id, { isActive: !round.isActive })
      await load()
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busy = false
    }
  }

  async function removeRound(round: VisitRound) {
    busy = true
    try {
      await api.admin.visits.deleteRound(round.id)
      say(`ลบ ${round.label} แล้ว`)
      await load()
    } catch (err) {
      // A round already in the calendar cannot be deleted — that is deliberate.
      say(toFormError(err).message, 'danger')
    } finally {
      busy = false
    }
  }

  /* ── the weekly template ───────────────────────────────────────────── */

  async function setCell(weekday: number, roundId: string, zoneId: string, capacity: number) {
    busy = true
    try {
      if (!zoneId) {
        const existing = cellFor(weekday, roundId)
        if (existing) await api.admin.visits.deleteTemplate(existing.id)
      } else {
        await api.admin.visits.setTemplate({ weekday, roundId, zoneId, capacity })
      }
      await load()
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busy = false
    }
  }
</script>

<div class="space-y-5">
  <div>
    <div class="flex items-center gap-2">
      <a class="text-sm text-brand-700 hover:underline" href="/visits">← ตารางเยี่ยม</a>
    </div>
    <h1 class="text-2xl font-semibold text-ink">รอบเยี่ยมและแม่แบบรายสัปดาห์</h1>
    <p class="text-muted">
      แม่แบบเป็นเพียงจุดตั้งต้นของปฏิทิน — เมื่อสร้างตารางแล้ว การแก้ไขทำที่หน้าตารางเยี่ยม · {session.scopeLabel}
    </p>
  </div>

  {#if message}
    <Alert {tone} title={message} />
  {/if}

  <Card title="รอบเยี่ยม" subtitle="กำหนดครั้งเดียวต่อเรือนจำ — จำนวนรอบต่อวันต่างกันไปในแต่ละแห่ง" padded={false}>
    <div class="overflow-x-auto">
      <table class="admin-table">
        <thead>
          <tr>
            <th>รอบที่</th>
            <th>ชื่อรอบ</th>
            <th>ช่วง</th>
            <th>เวลา</th>
            <th>สถานะ</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each rounds as round (round.id)}
            <tr>
              <td>{round.roundNo}</td>
              <td class="font-medium text-ink">{round.label}</td>
              <td>{round.session === 'morning' ? 'เช้า' : 'บ่าย'}</td>
              <td>{round.startTime}–{round.endTime}</td>
              <td>{round.isActive ? 'ใช้งาน' : 'ปิดใช้งาน'}</td>
              <td class="text-right whitespace-nowrap">
                {#if canSchedule}
                  <Button size="sm" variant="ghost" onclick={() => toggleRound(round)}>
                    {round.isActive ? 'ปิดใช้งาน' : 'เปิดใช้งาน'}
                  </Button>
                  <Button size="sm" variant="ghost" onclick={() => removeRound(round)}>ลบ</Button>
                {/if}
              </td>
            </tr>
          {:else}
            <tr><td colspan="6" class="py-8 text-center text-muted">ยังไม่มีรอบเยี่ยม</td></tr>
          {/each}
        </tbody>
      </table>
    </div>

    {#if canSchedule}
      <div class="flex flex-wrap items-end gap-2 border-t border-line px-5 py-4">
        <label class="text-sm">
          <span class="block text-muted">รอบที่</span>
          <input
            type="number"
            min="1"
            bind:value={newRound.roundNo}
            class="mt-1 w-20 rounded-xl border border-line bg-white px-3 py-2 text-ink"
          />
        </label>
        <label class="text-sm">
          <span class="block text-muted">ชื่อรอบ</span>
          <input
            type="text"
            bind:value={newRound.label}
            placeholder="รอบที่ 5"
            class="mt-1 w-40 rounded-xl border border-line bg-white px-3 py-2 text-ink"
          />
        </label>
        <label class="text-sm">
          <span class="block text-muted">ช่วง</span>
          <select
            bind:value={newRound.session}
            class="mt-1 rounded-xl border border-line bg-white px-3 py-2 text-ink"
          >
            <option value="morning">เช้า</option>
            <option value="afternoon">บ่าย</option>
          </select>
        </label>
        <label class="text-sm">
          <span class="block text-muted">เริ่ม</span>
          <input
            type="time"
            bind:value={newRound.startTime}
            class="mt-1 rounded-xl border border-line bg-white px-3 py-2 text-ink"
          />
        </label>
        <label class="text-sm">
          <span class="block text-muted">สิ้นสุด</span>
          <input
            type="time"
            bind:value={newRound.endTime}
            class="mt-1 rounded-xl border border-line bg-white px-3 py-2 text-ink"
          />
        </label>
        <Button loading={busy} disabled={!newRound.label.trim()} onclick={addRound}>เพิ่มรอบ</Button>
      </div>
    {/if}
  </Card>

  <Card
    title="แม่แบบรายสัปดาห์ (ตารางหน้า 12)"
    subtitle="วันไหน รอบไหน เยี่ยมแดนไหน — ใช้เป็นจุดตั้งต้นของปฏิทิน ไม่ใช่กติกาที่ประเมินตอนจอง"
    padded={false}
  >
    <div class="overflow-x-auto">
      <table class="w-full min-w-[48rem] border-collapse">
        <thead>
          <tr>
            <th class="w-40 border-b border-line px-3 py-2 text-left text-sm text-muted">วัน</th>
            {#each rounds.filter((r) => r.isActive) as round (round.id)}
              <th class="border-b border-line px-2 py-2 text-center text-sm">
                <div class="font-medium text-ink">{round.label}</div>
                <div class="text-xs text-muted">{round.startTime}–{round.endTime}</div>
              </th>
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each WEEKDAYS as day (day.weekday)}
            <tr>
              <th class="border-b border-line px-3 py-2 text-left font-medium text-ink">
                {day.label}
              </th>
              {#each rounds.filter((r) => r.isActive) as round (round.id)}
                {@const cell = cellFor(day.weekday, round.id)}
                <td class="border-b border-line px-1.5 py-1.5 text-center">
                  <select
                    disabled={!canSchedule || busy}
                    value={cell?.zoneId ?? ''}
                    onchange={(e) =>
                      setCell(
                        day.weekday,
                        round.id,
                        (e.currentTarget as HTMLSelectElement).value,
                        cell?.capacity ?? 20
                      )}
                    class="w-full rounded-lg border border-line bg-white px-2 py-1 text-xs text-ink disabled:bg-canvas"
                  >
                    <option value="">— ไม่มี —</option>
                    {#each zones as zone (zone.id)}
                      <option value={zone.id}>{zone.name}</option>
                    {/each}
                  </select>
                  {#if cell}
                    <input
                      type="number"
                      min="0"
                      disabled={!canSchedule || busy}
                      value={cell.capacity}
                      onchange={(e) =>
                        setCell(
                          day.weekday,
                          round.id,
                          cell.zoneId,
                          Number((e.currentTarget as HTMLInputElement).value)
                        )}
                      class="mt-1 w-full rounded-lg border border-line bg-white px-2 py-1 text-center text-xs text-ink"
                      title="ความจุ (ที่นั่ง)"
                    />
                  {/if}
                </td>
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <p class="border-t border-line px-5 py-3 text-sm text-muted">
      แก้แม่แบบแล้วอย่าลืมกด “สร้างตารางล่วงหน้าจากแม่แบบ” ที่หน้าตารางเยี่ยม —
      ช่องที่มีอยู่แล้วจะไม่ถูกเขียนทับ การกดซ้ำจึงปลอดภัยเสมอ
    </p>
  </Card>
</div>
