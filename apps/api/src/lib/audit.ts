import { db as defaultDb, type Db } from '../db/client.js'
import { auditLogs, type AuditActorType } from '../db/schema/index.js'

export interface AuditEntry {
  actorType: AuditActorType
  actorId?: string | null
  actorLabel?: string | null
  action: string
  entity: string
  entityId?: string | null
  prisonId?: string | null
  before?: unknown
  after?: unknown
  ip?: string | null
  userAgent?: string | null
}

/** Never log a secret. Anything matching these keys is masked before storage. */
const REDACT = /password|token|secret|hash|slip_raw/i

function scrub(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(scrub)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT.test(k) ? '[redacted]' : scrub(v)
  }
  return out
}

const encode = (v: unknown) => (v === undefined ? null : JSON.stringify(scrub(v)))

/**
 * Synchronous by design: better-sqlite3 writes inline, so an audit row lands in
 * the same transaction as the change it describes when called inside one.
 */
export function writeAudit(entry: AuditEntry, db: Db = defaultDb()) {
  db.insert(auditLogs)
    .values({
      actorType: entry.actorType,
      actorId: entry.actorId ?? null,
      actorLabel: entry.actorLabel ?? null,
      action: entry.action,
      entity: entry.entity,
      entityId: entry.entityId ?? null,
      prisonId: entry.prisonId ?? null,
      beforeJson: encode(entry.before),
      afterJson: encode(entry.after),
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null
    })
    .run()
}
