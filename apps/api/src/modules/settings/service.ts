import { and, eq, isNull } from 'drizzle-orm'
import { db as defaultDb, type Db } from '../../db/client.js'
import { settings } from '../../db/schema/index.js'
import { badRequest } from '../../lib/errors.js'
import { writeAudit } from '../../lib/audit.js'
import { now } from '../../lib/time.js'
import { REGISTRY, isSettingKey, settingKeys, type SettingKey, type SettingValue } from './registry.js'

/**
 * Reads fall back through: prison override → global row → declared default.
 * A key with no row anywhere is still fully configured.
 */
export function getSetting<K extends SettingKey>(
  key: K,
  opts: { prisonId?: string | null; db?: Db } = {}
): SettingValue<K> {
  const db = opts.db ?? defaultDb()
  const def = REGISTRY[key]

  if (def.scope === 'prison' && opts.prisonId) {
    const row = db
      .select()
      .from(settings)
      .where(and(eq(settings.key, key), eq(settings.scope, 'prison'), eq(settings.scopeId, opts.prisonId)))
      .get()
    const parsed = row && def.schema.safeParse(JSON.parse(row.valueJson))
    if (parsed?.success) return parsed.data as SettingValue<K>
  }

  const row = db
    .select()
    .from(settings)
    .where(and(eq(settings.key, key), eq(settings.scope, 'global'), isNull(settings.scopeId)))
    .get()
  if (!row) return def.default as SettingValue<K>

  const parsed = def.schema.safeParse(JSON.parse(row.valueJson))
  if (!parsed.success) {
    // A stored value that no longer satisfies the schema (a shipped schema
    // change) must not take the API down — fall back and make it visible.
    console.warn(`[settings] ${key} in database fails validation, using default`)
    return def.default as SettingValue<K>
  }
  return parsed.data as SettingValue<K>
}

export function setSetting(
  key: string,
  value: unknown,
  opts: {
    prisonId?: string | null
    actorId?: string | null
    actorLabel?: string | null
    db?: Db
  } = {}
) {
  if (!isSettingKey(key)) throw badRequest(`ไม่รู้จักการตั้งค่า "${key}"`)
  const db = opts.db ?? defaultDb()
  const def = REGISTRY[key]

  const parsed = def.schema.safeParse(value)
  if (!parsed.success) {
    const fields: Record<string, string[]> = {}
    for (const issue of parsed.error.issues) {
      ;(fields[issue.path.join('.') || 'value'] ??= []).push(issue.message)
    }
    throw badRequest(`ค่าของ "${key}" ไม่ถูกต้อง`, fields)
  }

  const scope = def.scope === 'prison' && opts.prisonId ? 'prison' : 'global'
  if (scope === 'global' && def.scope === 'prison' && opts.prisonId) {
    throw badRequest(`"${key}" ต้องระบุเรือนจำ`)
  }
  const scopeId = scope === 'prison' ? (opts.prisonId ?? null) : null

  const before = getSetting(key, { prisonId: opts.prisonId, db })
  db.insert(settings)
    .values({
      key,
      valueJson: JSON.stringify(parsed.data),
      scope,
      scopeId,
      updatedBy: opts.actorId ?? null,
      updatedAt: now()
    })
    .onConflictDoUpdate({
      target: [settings.key, settings.scope, settings.scopeId],
      set: {
        valueJson: JSON.stringify(parsed.data),
        updatedBy: opts.actorId ?? null,
        updatedAt: now()
      }
    })
    .run()

  writeAudit(
    {
      actorType: opts.actorId ? 'staff' : 'system',
      actorId: opts.actorId ?? null,
      actorLabel: opts.actorLabel ?? null,
      action: 'settings.update',
      entity: 'settings',
      entityId: key,
      prisonId: scopeId,
      before,
      after: parsed.data
    },
    db
  )

  return parsed.data
}

export interface SettingView {
  key: SettingKey
  label: string
  scope: 'global' | 'prison'
  exposed: boolean
  value: unknown
  isDefault: boolean
}

export function listSettings(opts: { prisonId?: string | null; db?: Db } = {}): SettingView[] {
  return settingKeys.map((key) => {
    const value = getSetting(key, opts)
    return {
      key,
      label: REGISTRY[key].label,
      scope: REGISTRY[key].scope,
      exposed: REGISTRY[key].exposed,
      value,
      isDefault: JSON.stringify(value) === JSON.stringify(REGISTRY[key].default)
    }
  })
}

/** The projection the customer app reads (packages/contract → PublicSettings). */
export function publicSettings(opts: { prisonId?: string | null; db?: Db } = {}) {
  const g = <K extends SettingKey>(k: K) => getSetting(k, opts)
  return {
    contact: {
      phone: g('contact.phone'),
      email: g('contact.email'),
      lineOfficial: g('contact.line_official'),
      addressTh: g('contact.address_th')
    },
    order: { cutoffTime: g('order.cutoff_time') },
    visit: {
      horizonWeeks: g('visit.horizon_weeks'),
      bookingCutoffHours: g('visit.booking_cutoff_hours')
    },
    payment: { qrTtlMinutes: g('payment.qr.ttl_minutes') },
    features: { lineLogin: g('features.line_login') }
  }
}
