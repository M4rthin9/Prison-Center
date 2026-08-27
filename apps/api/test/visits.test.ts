import { beforeAll, describe, expect, it } from 'vitest'
import { BASE, loginCustomer, loginStaff, setupApp, type TestClient } from './helpers.js'

const ctx = setupApp()
const app = () => ctx.app

const { db } = await import('../src/db/client.js')
const { setSetting } = await import('../src/modules/settings/service.js')
const { createBooking, materializeSchedule } = await import('../src/modules/visits/service.js')
const { addDays, bangkokDate } = await import('../src/lib/time.js')
const { customerInmates, customers, inmates, prisons, visitScheduleDays, zones } = await import(
  '../src/db/schema/index.js'
)
const { and, eq } = await import('drizzle-orm')

/* ── fixtures ──────────────────────────────────────────────────────────── */

async function relative(username = '0812345678') {
  const { client } = await loginCustomer(app(), username)
  const me = (await client.json(`${BASE}/me`)) as any
  const inmate = me.inmates.find((i: any) => i.verifyStatus === 'verified')
  return { client, inmate, me }
}

const staffClient = async (username = 'klp.admin') => (await loginStaff(app(), username)).client

/** Far enough out that the 24-hour cutoff can never eat the fixture. */
const soon = () => addDays(bangkokDate(), 7)

/**
 * The first slot this inmate can actually take: bookable, and on a date they
 * do not already hold a live booking for. Tests share one seeded inmate, and
 * "one visit per inmate per day" would otherwise make every test after the
 * first one fail for the wrong reason.
 */
async function firstBookableSlot(client: TestClient, inmateId: string, from = soon()) {
  const [avail, mine] = await Promise.all([
    client.json(`${BASE}/visits/availability?inmateId=${inmateId}&from=${from}`) as any,
    client.json(`${BASE}/visits?limit=100`) as any
  ])
  const taken = new Set(
    mine.items
      .filter((b: any) => b.inmateId === inmateId && b.status !== 'cancelled')
      .map((b: any) => b.visitDate)
  )
  return avail.slots.find((s: any) => s.isBookable && !taken.has(s.date))
}

beforeAll(() => {
  // The suite books the same seeded inmate repeatedly; the per-inmate open cap
  // has its own test and would otherwise fire everywhere else first.
  setSetting('visit.max_open_per_inmate', 20, { db: db() })
})

/* ── rounds & template ─────────────────────────────────────────────────── */

describe('rounds', () => {
  it('lists the seeded rounds for a prison, scoped to the staff member', async () => {
    const staff = await staffClient()
    const res = (await staff.json(`${BASE}/admin/visit-rounds`)) as any
    expect(res.items.length).toBe(4)
    expect(res.items[0].label).toBe('รอบที่ 1')
    expect(res.items.every((r: any) => r.prisonId === res.items[0].prisonId)).toBe(true)
  })

  it('refuses a duplicate round number in the same facility', async () => {
    const staff = await staffClient()
    const res = await staff.request(`${BASE}/admin/visit-rounds`, {
      method: 'POST',
      json: { roundNo: 1, label: 'ซ้ำ', session: 'morning', startTime: '08:00', endTime: '08:30' }
    })
    expect(res.status).toBe(409)
  })

  it('refuses an end time before the start time', async () => {
    const staff = await staffClient()
    const res = await staff.request(`${BASE}/admin/visit-rounds`, {
      method: 'POST',
      json: { roundNo: 9, label: 'กลับหลัง', session: 'morning', startTime: '10:00', endTime: '09:00' }
    })
    expect(res.status).toBe(400)
  })

  it('creates, edits and then refuses to delete a round that is in the calendar', async () => {
    const staff = await staffClient()
    const created = (await staff.json(`${BASE}/admin/visit-rounds`, {
      method: 'POST',
      json: { roundNo: 8, label: 'รอบพิเศษ', session: 'afternoon', startTime: '15:00', endTime: '15:40' }
    })) as any
    expect(created.roundNo).toBe(8)

    const patched = (await staff.json(`${BASE}/admin/visit-rounds/${created.id}`, {
      method: 'PATCH',
      json: { label: 'รอบพิเศษ (เย็น)', isActive: false }
    })) as any
    expect(patched.label).toBe('รอบพิเศษ (เย็น)')
    expect(patched.isActive).toBe(false)

    // Never scheduled → deletable.
    expect((await staff.request(`${BASE}/admin/visit-rounds/${created.id}`, { method: 'DELETE' })).status).toBe(200)

    const seeded = (await staff.json(`${BASE}/admin/visit-rounds`)) as any
    const used = seeded.items[0]
    expect(
      (await staff.request(`${BASE}/admin/visit-rounds/${used.id}`, { method: 'DELETE' })).status
    ).toBe(409)
  })

  it('lets a zone_staff read rounds but never write them', async () => {
    const zoneStaff = await staffClient('klp.zone')
    expect((await zoneStaff.request(`${BASE}/admin/visit-rounds`)).status).toBe(200)
    const res = await zoneStaff.request(`${BASE}/admin/visit-rounds`, {
      method: 'POST',
      json: { roundNo: 7, label: 'x', session: 'morning', startTime: '08:00', endTime: '08:30' }
    })
    expect(res.status).toBe(403)
  })
})

/* ── materialize ───────────────────────────────────────────────────────── */

describe('materialize', () => {
  it('is idempotent — a second run creates nothing', async () => {
    const staff = await staffClient()
    const again = (await staff.json(`${BASE}/admin/visit-schedule/generate`, {
      method: 'POST',
      json: { weeks: 4 }
    })) as any
    expect(again.created).toBe(0)
    expect(again.skipped).toBeGreaterThan(0)
  })

  it('never touches a row a staff member has edited', async () => {
    const staff = await staffClient()
    const grid = (await staff.json(`${BASE}/admin/visit-schedule?from=${soon()}&to=${soon()}`)) as any
    const cell = grid.cells[0]
    expect(cell).toBeTruthy()

    await staff.json(`${BASE}/admin/visit-schedule/${cell.id}`, {
      method: 'PATCH',
      json: { capacity: 3, isClosed: true, note: 'ปิดปรับปรุงห้องเยี่ยม' }
    })

    await staff.json(`${BASE}/admin/visit-schedule/generate`, { method: 'POST', json: { weeks: 4 } })

    const after = (await staff.json(`${BASE}/admin/visit-schedule?from=${soon()}&to=${soon()}`)) as any
    const same = after.cells.find((c: any) => c.id === cell.id)
    expect(same.capacity).toBe(3)
    expect(same.isClosed).toBe(true)
    expect(same.source).toBe('manual')

    // Put it back so the booking tests have a live cell again.
    await staff.json(`${BASE}/admin/visit-schedule/${cell.id}`, {
      method: 'PATCH',
      json: { capacity: 20, isClosed: false, note: null }
    })
  })

  it('extends the horizon rather than rewriting it', async () => {
    const staff = await staffClient()
    const wide = (await staff.json(`${BASE}/admin/visit-schedule/generate`, {
      method: 'POST',
      json: { weeks: 6 }
    })) as any
    expect(wide.created).toBeGreaterThan(0)
  })
})

/* ── the week grid ─────────────────────────────────────────────────────── */

describe('week grid', () => {
  it('returns rounds, zones and one cell per (date, round, zone)', async () => {
    const staff = await staffClient()
    const from = soon()
    const to = addDays(from, 6)
    const grid = (await staff.json(`${BASE}/admin/visit-schedule?from=${from}&to=${to}`)) as any

    expect(grid.dates.length).toBe(7)
    expect(grid.rounds.length).toBeGreaterThan(0)
    expect(grid.zones.length).toBeGreaterThan(0)
    const keys = grid.cells.map((c: any) => `${c.date}|${c.roundId}|${c.zoneId}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('adds a manual cell, refuses a duplicate of it, and deletes it again', async () => {
    const staff = await staffClient()
    const week = (await staff.json(
      `${BASE}/admin/visit-schedule?from=${soon()}&to=${addDays(soon(), 6)}`
    )) as any
    const roundId = week.rounds[0].id
    const zoneId = week.zones[week.zones.length - 1].id
    // The template already materialized most of the week; pick a day that has
    // no cell for this round+zone, or the "add" under test is a duplicate and
    // the case depends on which weekday the suite happens to run.
    const taken = new Set(
      week.cells.map((c: any) => `${c.date}|${c.roundId}|${c.zoneId}`)
    )
    const date = [...Array(7).keys()]
      .map((i) => addDays(soon(), i))
      .find((d) => !taken.has(`${d}|${roundId}|${zoneId}`))!
    expect(date, 'the seeded week has no free cell to add').toBeDefined()
    const body = { date, roundId, zoneId, capacity: 5, note: 'รอบเสริม' }

    const created = (await staff.json(`${BASE}/admin/visit-schedule`, { method: 'POST', json: body })) as any
    expect(created.source).toBe('manual')
    expect(created.capacity).toBe(5)

    expect((await staff.request(`${BASE}/admin/visit-schedule`, { method: 'POST', json: body })).status).toBe(409)
    expect((await staff.request(`${BASE}/admin/visit-schedule/${created.id}`, { method: 'DELETE' })).status).toBe(200)
  })

  it('closes and reopens a whole date range', async () => {
    const staff = await staffClient()
    // The seeded template only covers Mon–Fri, so pick a date the grid has.
    const week = (await staff.json(
      `${BASE}/admin/visit-schedule?from=${soon()}&to=${addDays(soon(), 6)}`
    )) as any
    const date = week.cells[0].date
    const closed = (await staff.json(`${BASE}/admin/visit-schedule/close`, {
      method: 'POST',
      json: { from: date, to: date, isClosed: true, note: 'วันหยุดนักขัตฤกษ์' }
    })) as any
    expect(closed.affected).toBeGreaterThan(0)

    const grid = (await staff.json(`${BASE}/admin/visit-schedule?from=${date}&to=${date}`)) as any
    expect(grid.cells.every((c: any) => c.isClosed)).toBe(true)

    await staff.json(`${BASE}/admin/visit-schedule/close`, {
      method: 'POST',
      json: { from: date, to: date, isClosed: false }
    })
  })

  it('refuses to drop capacity below what is already booked', async () => {
    const { client, inmate } = await relative()
    const slot = await firstBookableSlot(client, inmate.inmateId)
    await client.json(`${BASE}/visits`, {
      method: 'POST',
      json: {
        inmateId: inmate.inmateId,
        scheduleDayId: slot.scheduleDayId,
        visitorName: 'สมหญิง ใจดี',
        contactPhone: '0812345678'
      }
    })

    const staff = await staffClient()
    const res = await staff.request(`${BASE}/admin/visit-schedule/${slot.scheduleDayId}`, {
      method: 'PATCH',
      json: { capacity: 0 }
    })
    expect(res.status).toBe(409)
  })
})

/* ── availability ──────────────────────────────────────────────────────── */

describe('availability', () => {
  it('only offers cells in the inmate’s own แดน', async () => {
    const { client, inmate } = await relative()
    const res = (await client.json(`${BASE}/visits/availability?inmateId=${inmate.inmateId}`)) as any
    expect(res.slots.length).toBeGreaterThan(0)
    expect(res.slots.every((s: any) => s.zoneId === inmate.zoneId)).toBe(true)
  })

  it('never reaches past the facility’s horizon', async () => {
    const { client, inmate } = await relative()
    const far = addDays(bangkokDate(), 200)
    const res = (await client.json(
      `${BASE}/visits/availability?inmateId=${inmate.inmateId}&to=${far}`
    )) as any
    expect(res.to < far).toBe(true)
    expect(res.slots.every((s: any) => s.date <= res.to)).toBe(true)
  })

  it('marks today’s slots unbookable once the cutoff has passed', async () => {
    const { client, inmate } = await relative()
    const today = bangkokDate()
    const res = (await client.json(
      `${BASE}/visits/availability?inmateId=${inmate.inmateId}&from=${today}&to=${today}`
    )) as any
    expect(res.cutoffHours).toBe(24)
    expect(res.slots.every((s: any) => s.isBookable === false)).toBe(true)
  })

  it('refuses a relative whose link is not verified', async () => {
    const { client } = await loginCustomer(app(), '0845678901')
    const me = (await client.json(`${BASE}/me`)) as any
    const res = await client.request(
      `${BASE}/visits/availability?inmateId=${me.inmates[0].inmateId}`
    )
    expect(res.status).toBe(403)
  })
})

/* ── booking ───────────────────────────────────────────────────────────── */

describe('booking', () => {
  it('books a slot, numbers it, and moves the counter by exactly one', async () => {
    const { client, inmate } = await relative()
    const slot = await firstBookableSlot(client, inmate.inmateId)
    const before = slot.bookedCount

    const booking = (await client.json(`${BASE}/visits`, {
      method: 'POST',
      json: {
        inmateId: inmate.inmateId,
        scheduleDayId: slot.scheduleDayId,
        visitorName: 'สมหญิง ใจดี',
        contactPhone: '0812345678',
        visitorCount: 2
      }
    })) as any

    expect(booking.bookingNo).toMatch(/^KLP-V\d{4}-\d{4}$/)
    expect(booking.status).toBe('confirmed')
    expect(booking.visitDate).toBe(slot.date)
    expect(booking.zoneName).toBe(slot.zoneName)

    const cell = db()
      .select()
      .from(visitScheduleDays)
      .where(eq(visitScheduleDays.id, slot.scheduleDayId))
      .get()!
    expect(cell.bookedCount).toBe(before + 1)
  })

  it('refuses a second live booking for the same inmate on the same day', async () => {
    const { client, inmate } = await relative()
    const slot = await firstBookableSlot(client, inmate.inmateId)
    await client.json(`${BASE}/visits`, {
      method: 'POST',
      json: {
        inmateId: inmate.inmateId,
        scheduleDayId: slot.scheduleDayId,
        visitorName: 'สมหญิง ใจดี',
        contactPhone: '0812345678'
      }
    })

    const same = (await client.json(
      `${BASE}/visits/availability?inmateId=${inmate.inmateId}&from=${slot.date}&to=${slot.date}`
    )) as any
    const other = same.slots.find(
      (s: any) => s.isBookable && s.scheduleDayId !== slot.scheduleDayId
    )
    if (!other) return

    const res = await client.request(`${BASE}/visits`, {
      method: 'POST',
      json: {
        inmateId: inmate.inmateId,
        scheduleDayId: other.scheduleDayId,
        visitorName: 'สมหญิง ใจดี',
        contactPhone: '0812345678'
      }
    })
    expect(res.status).toBe(409)
  })

  it('refuses a closed slot and a slot in another แดน', async () => {
    const { client, inmate } = await relative()
    const staff = await staffClient()
    const slot = await firstBookableSlot(client, inmate.inmateId)

    await staff.json(`${BASE}/admin/visit-schedule/${slot.scheduleDayId}`, {
      method: 'PATCH',
      json: { isClosed: true }
    })
    const closed = await client.request(`${BASE}/visits`, {
      method: 'POST',
      json: {
        inmateId: inmate.inmateId,
        scheduleDayId: slot.scheduleDayId,
        visitorName: 'สมหญิง ใจดี',
        contactPhone: '0812345678'
      }
    })
    expect(closed.status).toBe(409)
    await staff.json(`${BASE}/admin/visit-schedule/${slot.scheduleDayId}`, {
      method: 'PATCH',
      json: { isClosed: false }
    })

    const foreign = db()
      .select()
      .from(visitScheduleDays)
      .where(eq(visitScheduleDays.prisonId, inmate.prisonId))
      .all()
      .find((c) => c.zoneId !== inmate.zoneId)!
    const res = await client.request(`${BASE}/visits`, {
      method: 'POST',
      json: {
        inmateId: inmate.inmateId,
        scheduleDayId: foreign.id,
        visitorName: 'สมหญิง ใจดี',
        contactPhone: '0812345678'
      }
    })
    expect(res.status).toBe(400)
  })

  it('refuses a booking inside the cutoff window', async () => {
    const { client, inmate } = await relative()
    const today = bangkokDate()
    const res = (await client.json(
      `${BASE}/visits/availability?inmateId=${inmate.inmateId}&from=${today}&to=${today}`
    )) as any
    const slot = res.slots[0]
    if (!slot) return

    const booked = await client.request(`${BASE}/visits`, {
      method: 'POST',
      json: {
        inmateId: inmate.inmateId,
        scheduleDayId: slot.scheduleDayId,
        visitorName: 'สมหญิง ใจดี',
        contactPhone: '0812345678'
      }
    })
    expect(booked.status).toBe(409)
  })

  it('caps the number of visitors on one booking', async () => {
    const { client, inmate } = await relative()
    const slot = await firstBookableSlot(client, inmate.inmateId)
    const res = await client.request(`${BASE}/visits`, {
      method: 'POST',
      json: {
        inmateId: inmate.inmateId,
        scheduleDayId: slot.scheduleDayId,
        visitorName: 'สมหญิง ใจดี',
        contactPhone: '0812345678',
        visitorCount: 9
      }
    })
    expect(res.status).toBe(400)
  })

  it('refuses one relative access to another’s booking', async () => {
    const { client, inmate } = await relative()
    const slot = await firstBookableSlot(client, inmate.inmateId)
    const booking = (await client.json(`${BASE}/visits`, {
      method: 'POST',
      json: {
        inmateId: inmate.inmateId,
        scheduleDayId: slot.scheduleDayId,
        visitorName: 'สมหญิง ใจดี',
        contactPhone: '0812345678'
      }
    })) as any

    const { client: other } = await loginCustomer(app(), '0823456789')
    expect((await other.request(`${BASE}/visits/${booking.id}`)).status).toBe(403)
  })
})

/* ── the concurrency guarantee (§4.6) ──────────────────────────────────── */

describe('overselling', () => {
  /**
   * The point of the whole design. `capacity = 3`, ten relatives pressing the
   * button at once: exactly three rows, and `booked_count` equal to capacity.
   * Each booking is a different inmate, because one visit per inmate per day
   * would otherwise mask the capacity check with a different guard.
   */
  it('is impossible under concurrent booking', async () => {
    const staff = await staffClient()
    const date = addDays(bangkokDate(), 20)
    materializeSchedule(
      db()
        .select({ id: prisons.id })
        .from(prisons)
        .where(eq(prisons.code, 'KLP'))
        .get()!.id,
      { weeks: 6 },
      db()
    )

    const prisonId = db().select({ id: prisons.id }).from(prisons).where(eq(prisons.code, 'KLP')).get()!.id
    const zone = db().select().from(zones).where(eq(zones.prisonId, prisonId)).all()[0]!
    const roundsRes = (await staff.json(`${BASE}/admin/visit-rounds`)) as any

    const cell = (await staff.json(`${BASE}/admin/visit-schedule`, {
      method: 'POST',
      json: {
        date,
        roundId: roundsRes.items[0].id,
        zoneId: zone.id,
        capacity: 3,
        note: 'ทดสอบการจองพร้อมกัน'
      }
    })) as any

    // Ten inmates in that แดน, each with a verified relative link, so the only
    // thing that can stop a booking is the capacity itself.
    const customer = db().select().from(customers).where(eq(customers.phone, '0812345678')).get()!
    const inmateIds: string[] = []
    for (let i = 0; i < 10; i++) {
      const row = db()
        .insert(inmates)
        .values({
          prisonId,
          zoneId: zone.id,
          inmateCode: `KLP-RACE-${i}`,
          fullName: `ผู้ต้องขังทดสอบ ${i}`,
          status: 'active'
        })
        .returning({ id: inmates.id })
        .get()
      inmateIds.push(row.id)
      db()
        .insert(customerInmates)
        .values({
          customerId: customer.id,
          inmateId: row.id,
          verifyStatus: 'verified',
          verifiedAt: Date.now()
        })
        .run()
    }

    const results = await Promise.allSettled(
      inmateIds.map((inmateId) =>
        createBooking(customer.id, {
          inmateId,
          scheduleDayId: cell.id,
          visitorName: 'สมหญิง ใจดี',
          contactPhone: '0812345678'
        })
      )
    )

    const ok = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(ok.length).toBe(3)
    expect(rejected.length).toBe(7)

    const after = db().select().from(visitScheduleDays).where(eq(visitScheduleDays.id, cell.id)).get()!
    expect(after.bookedCount).toBe(3)
    expect(after.bookedCount).toBeLessThanOrEqual(after.capacity)
  })
})

/* ── cancel, check-in, no-show ─────────────────────────────────────────── */

describe('the gate desk', () => {
  async function aBooking() {
    const { client, inmate } = await relative()
    const slot = await firstBookableSlot(client, inmate.inmateId)
    const booking = (await client.json(`${BASE}/visits`, {
      method: 'POST',
      json: {
        inmateId: inmate.inmateId,
        scheduleDayId: slot.scheduleDayId,
        visitorName: 'สมหญิง ใจดี',
        contactPhone: '0812345678'
      }
    })) as any
    return { client, booking, slot }
  }

  it('gives the seat back on cancellation, in the same transaction', async () => {
    const { client, booking, slot } = await aBooking()
    const held = db().select().from(visitScheduleDays).where(eq(visitScheduleDays.id, slot.scheduleDayId)).get()!

    const cancelled = (await client.json(`${BASE}/visits/${booking.id}/cancel`, {
      method: 'POST',
      json: { reason: 'ติดธุระ' }
    })) as any
    expect(cancelled.status).toBe('cancelled')

    const after = db().select().from(visitScheduleDays).where(eq(visitScheduleDays.id, slot.scheduleDayId)).get()!
    expect(after.bookedCount).toBe(held.bookedCount - 1)
  })

  it('lets the same inmate rebook that day once the slot is released', async () => {
    const { client, inmate } = await relative()
    const slot = await firstBookableSlot(client, inmate.inmateId)
    const first = (await client.json(`${BASE}/visits`, {
      method: 'POST',
      json: {
        inmateId: inmate.inmateId,
        scheduleDayId: slot.scheduleDayId,
        visitorName: 'สมหญิง ใจดี',
        contactPhone: '0812345678'
      }
    })) as any
    await client.json(`${BASE}/visits/${first.id}/cancel`, { method: 'POST', json: {} })

    const again = await client.request(`${BASE}/visits`, {
      method: 'POST',
      json: {
        inmateId: inmate.inmateId,
        scheduleDayId: slot.scheduleDayId,
        visitorName: 'สมหญิง ใจดี',
        contactPhone: '0812345678'
      }
    })
    expect(again.status).toBe(201)
  })

  it('checks a visitor in and refuses to cancel afterwards', async () => {
    const { client, booking } = await aBooking()
    const staff = await staffClient('klp.zone')

    const checked = (await staff.json(`${BASE}/admin/visits/${booking.id}/check-in`, {
      method: 'POST'
    })) as any
    expect(checked.status).toBe('checked_in')
    expect(checked.checkedInAt).toBeGreaterThan(0)

    expect((await client.request(`${BASE}/visits/${booking.id}/cancel`, { method: 'POST', json: {} })).status).toBe(409)
  })

  it('records a no-show without giving the seat back', async () => {
    const { booking, slot } = await aBooking()
    const held = db().select().from(visitScheduleDays).where(eq(visitScheduleDays.id, slot.scheduleDayId)).get()!
    const staff = await staffClient('klp.zone')

    const marked = (await staff.json(`${BASE}/admin/visits/${booking.id}/status`, {
      method: 'POST',
      json: { status: 'no_show' }
    })) as any
    expect(marked.status).toBe('no_show')

    const after = db().select().from(visitScheduleDays).where(eq(visitScheduleDays.id, slot.scheduleDayId)).get()!
    expect(after.bookedCount).toBe(held.bookedCount)
  })

  it('refuses an impossible status transition', async () => {
    const { booking } = await aBooking()
    const staff = await staffClient('klp.zone')
    await staff.json(`${BASE}/admin/visits/${booking.id}/status`, {
      method: 'POST',
      json: { status: 'checked_in' }
    })
    const res = await staff.request(`${BASE}/admin/visits/${booking.id}/status`, {
      method: 'POST',
      json: { status: 'no_show' }
    })
    expect(res.status).toBe(409)
  })

  it('lets staff cancel past the cutoff, and refuses the family the same thing', async () => {
    const { client, inmate } = await relative()
    // The nearest bookable date, so a 7-day cutoff definitely covers it.
    const slot = await firstBookableSlot(client, inmate.inmateId, bangkokDate())
    const booking = (await client.json(`${BASE}/visits`, {
      method: 'POST',
      json: {
        inmateId: inmate.inmateId,
        scheduleDayId: slot.scheduleDayId,
        visitorName: 'สมหญิง ใจดี',
        contactPhone: '0812345678'
      }
    })) as any

    // Widen the cutoff so the booking is now inside it without touching the clock.
    setSetting('visit.booking_cutoff_hours', 168, { prisonId: inmate.prisonId, db: db() })
    expect(
      (await client.request(`${BASE}/visits/${booking.id}/cancel`, { method: 'POST', json: {} })).status
    ).toBe(409)

    const staff = await staffClient()
    const cancelled = (await staff.json(`${BASE}/admin/visits/${booking.id}/status`, {
      method: 'POST',
      json: { status: 'cancelled', reason: 'เรือนจำงดเยี่ยม' }
    })) as any
    expect(cancelled.status).toBe('cancelled')
    expect(cancelled.cancelledReason).toBe('เรือนจำงดเยี่ยม')

    setSetting('visit.booking_cutoff_hours', 24, { prisonId: inmate.prisonId, db: db() })
  })
})

/* ── scope ─────────────────────────────────────────────────────────────── */

describe('prison scope', () => {
  it('hides another facility’s bookings and its calendar', async () => {
    const bkw = await staffClient('bkw.admin')
    const list = (await bkw.json(`${BASE}/admin/visits?limit=100`)) as any
    expect(list.items.every((b: any) => b.prisonName.includes('บางขวาง'))).toBe(true)

    const klpPrison = db().select().from(prisons).where(eq(prisons.code, 'KLP')).get()!
    const res = await bkw.request(`${BASE}/admin/visit-schedule?prisonId=${klpPrison.id}`)
    expect(res.status).toBe(403)
  })

  it('refuses a cross-prison booking detail read', async () => {
    const { client, inmate } = await relative()
    const slot = await firstBookableSlot(client, inmate.inmateId)
    const booking = (await client.json(`${BASE}/visits`, {
      method: 'POST',
      json: {
        inmateId: inmate.inmateId,
        scheduleDayId: slot.scheduleDayId,
        visitorName: 'สมหญิง ใจดี',
        contactPhone: '0812345678'
      }
    })) as any

    const bkw = await staffClient('bkw.admin')
    expect((await bkw.request(`${BASE}/admin/visits/${booking.id}`)).status).toBe(403)
  })
})

/* ── summary ───────────────────────────────────────────────────────────── */

describe('summary', () => {
  it('counts live and honoured bookings but not cancellations', async () => {
    const staff = await staffClient()
    const totals = (await staff.json(`${BASE}/admin/visits/summary`)) as any
    const live = totals.buckets
      .filter((b: any) => b.status !== 'cancelled')
      .reduce((n: number, b: any) => n + b.count, 0)
    expect(totals.bookedCount).toBe(live)
    expect(totals.capacityTotal).toBeGreaterThan(0)
    expect(totals.utilisation).toBeLessThanOrEqual(1)
  })
})

/* ── the reminder job ──────────────────────────────────────────────────── */

describe('reminders', () => {
  it('notifies a family once and never twice', async () => {
    const { sendVisitReminders } = await import('../src/modules/visits/service.js')
    const { visitBookings } = await import('../src/db/schema/index.js')
    const { notifications } = await import('../src/db/schema/index.js')

    const live = db()
      .select()
      .from(visitBookings)
      .where(eq(visitBookings.status, 'confirmed'))
      .all()
    expect(live.length).toBeGreaterThan(0)

    // Pretend we are a few hours before the earliest booking.
    const target = live.sort((a, b) => a.startsAt - b.startsAt)[0]!
    const at = target.startsAt - 6 * 60 * 60 * 1000

    const first = await sendVisitReminders(at, db())
    expect(first.sent).toBeGreaterThan(0)
    const second = await sendVisitReminders(at, db())
    expect(second.sent).toBe(0)

    const sent = db()
      .select()
      .from(notifications)
      .where(and(eq(notifications.kind, 'visit.reminder'), eq(notifications.recipientId, target.customerId)))
      .all()
    expect(sent.length).toBeGreaterThan(0)
  })
})
