import { eq } from 'drizzle-orm'
import type { Db } from '../client.js'
import { visitRounds, visitScheduleTemplates, zones } from '../schema/index.js'
import { materializeSchedule } from '../../modules/visits/service.js'

/**
 * §4.6 fixtures. Rounds are per-facility because the count genuinely differs;
 * the template is the p.12 grid (Mon AM → แดน 6, Mon PM → แดน 3 …) and exists
 * only so `pnpm dev` opens on a calendar with something in it. Everything the
 * grid shows afterwards is materialized rows, not this table.
 */

interface SeedRound {
  roundNo: number
  label: string
  session: 'morning' | 'afternoon'
  startTime: string
  endTime: string
}

const ROUNDS: SeedRound[] = [
  { roundNo: 1, label: 'รอบที่ 1', session: 'morning', startTime: '09:00', endTime: '09:40' },
  { roundNo: 2, label: 'รอบที่ 2', session: 'morning', startTime: '10:00', endTime: '10:40' },
  { roundNo: 3, label: 'รอบที่ 3', session: 'afternoon', startTime: '13:00', endTime: '13:40' },
  { roundNo: 4, label: 'รอบที่ 4', session: 'afternoon', startTime: '14:00', endTime: '14:40' }
]

export function seedVisits(db: Db, prisonIds: Record<string, string>) {
  let rounds = 0
  let templates = 0
  let days = 0

  for (const prisonId of Object.values(prisonIds)) {
    const roundIds = ROUNDS.map((r) => {
      rounds++
      return db.insert(visitRounds).values({ prisonId, ...r, sortOrder: r.roundNo }).returning({
        id: visitRounds.id
      }).get().id
    })

    const zoneIds = db
      .select({ id: zones.id })
      .from(zones)
      .where(eq(zones.prisonId, prisonId))
      .all()
      .map((z) => z.id)

    // Monday–Friday, every round, rotating แดน — enough shape that the week
    // grid has holes and repeats rather than a uniform block.
    for (let weekday = 1; weekday <= 5; weekday++) {
      roundIds.forEach((roundId, i) => {
        const zoneId = zoneIds[(weekday + i) % zoneIds.length]
        if (!zoneId) return
        db.insert(visitScheduleTemplates)
          .values({ prisonId, weekday, roundId, zoneId, capacity: 20 })
          .run()
        templates++
      })
    }

    days += materializeSchedule(prisonId, {}, db).created
  }

  return { visitRounds: rounds, visitTemplates: templates, visitScheduleDays: days }
}
