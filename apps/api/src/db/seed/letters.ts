import type { Db } from '../client.js'
import { letterPackages, type LetterDirection } from '../schema/index.js'
import { getSetting } from '../../modules/settings/service.js'

/**
 * The packages a fresh install offers. The shapes come from the
 * `letter.packages` setting so the p.12 numbers (฿100 → 10 ฉบับ, both
 * directions) live in one declared place; the table is what the app reads
 * afterwards, because staff edit packages and nobody edits a settings key.
 */
export function seedLetterPackages(db: Db) {
  const declared = getSetting('letter.packages', { db })
  let n = 0
  for (const [i, pkg] of declared.entries()) {
    db.insert(letterPackages)
      .values({
        // Department-wide: every facility sells the same coupon on day one.
        prisonId: null,
        name: pkg.name,
        direction: pkg.direction as LetterDirection,
        priceSatang: pkg.priceSatang,
        quota: pkg.quota,
        isActive: true,
        sortOrder: (i + 1) * 10,
        note: 'ค่าตั้งต้นจากระบบ — แก้ไขราคาและจำนวนได้ที่หน้าจดหมาย'
      })
      .run()
    n++
  }
  return { letterPackages: n }
}
