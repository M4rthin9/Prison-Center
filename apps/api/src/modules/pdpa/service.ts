import { randomBytes } from 'node:crypto'
import { and, count, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm'
import { db as defaultDb, type Db } from '../../db/client.js'
import {
  auditLogs,
  customerSessions,
  customers,
  deposits,
  letterAttachments,
  letters,
  notifications,
  orders,
  payments,
  visitBookings
} from '../../db/schema/index.js'
import { writeAudit } from '../../lib/audit.js'
import { purgeOtpChallenges } from '../../lib/otp.js'
import { storage } from '../../lib/storage/index.js'
import { DAY, bangkokDate, now } from '../../lib/time.js'
import { purgeRateLimits } from '../../middleware/rate-limit.js'
import { getSetting } from '../settings/service.js'

export interface RetentionAction {
  key: string
  label: string
  /** Everything strictly older than this instant is in scope. */
  cutoffAt: number
  /** Rows affected — what *would* be touched in a dry run, what was in a real one. */
  rows: number
  /** Stored objects deleted (letter attachments, scans, slips). */
  files: number
}

export interface RetentionReport {
  at: number
  dryRun: boolean
  enabled: boolean
  actions: RetentionAction[]
  totalRows: number
  totalFiles: number
}

const daysAgo = (days: number, at: number) => at - days * DAY

/**
 * The PDPA retention job (decision #8).
 *
 * Two safety rails, both deliberate:
 *
 *  - `pdpa.retention.enabled` is off until the windows have departmental
 *    sign-off, and `pdpa.retention.dry_run` is on after that. A run with
 *    either switch engaged reports exactly what it would remove and removes
 *    nothing — which is how the month of dry-run rehearsal the plan asks for
 *    actually happens.
 *  - Personal *content* is purged while the record stays. A letter keeps its
 *    who/when/status so the p.12 letter report still balances a year later;
 *    a closed account is anonymized rather than deleted, so a deletion request
 *    never blows a hole in the ledger.
 */
export async function runRetention(
  opts: { dryRun?: boolean; db?: Db } = {}
): Promise<RetentionReport> {
  const db = opts.db ?? defaultDb()
  const at = now()
  const enabled = getSetting('pdpa.retention.enabled', { db })
  const dryRun = opts.dryRun ?? (!enabled || getSetting('pdpa.retention.dry_run', { db }))
  const window = (key: Parameters<typeof retentionDays>[0]) => daysAgo(retentionDays(key, db), at)

  const actions: RetentionAction[] = [
    await purgeLetterContent(db, window('letter_days'), dryRun),
    await purgeSlips(db, window('slip_days'), dryRun),
    purgeFinancial(db, window('financial_days'), dryRun),
    purgeVisits(db, window('visit_days'), dryRun),
    purgeAudit(db, window('audit_days'), dryRun),
    anonymizeClosedAccounts(db, window('closed_account_days'), dryRun),
    housekeeping(db, at, dryRun)
  ]

  const report: RetentionReport = {
    at,
    dryRun,
    enabled,
    actions,
    totalRows: actions.reduce((n, a) => n + a.rows, 0),
    totalFiles: actions.reduce((n, a) => n + a.files, 0)
  }

  writeAudit(
    {
      actorType: 'system',
      actorId: null,
      actorLabel: 'pdpa.retention',
      action: dryRun ? 'pdpa.retention_dry_run' : 'pdpa.retention_purge',
      entity: 'system',
      entityId: null,
      after: report
    },
    db
  )
  return report
}

type WindowKey =
  | 'letter_days'
  | 'slip_days'
  | 'financial_days'
  | 'visit_days'
  | 'audit_days'
  | 'closed_account_days'

const retentionDays = (key: WindowKey, db: Db): number =>
  getSetting(`pdpa.retention.${key}` as const, { db })

/* ── letters: purge the content, keep the record ───────────────────────── */

async function purgeLetterContent(
  db: Db,
  cutoff: number,
  dryRun: boolean
): Promise<RetentionAction> {
  const rows = db
    .select({ id: letters.id, scanImageKey: letters.scanImageKey })
    .from(letters)
    .where(
      and(
        lt(letters.createdAt, cutoff),
        // Already-purged letters have an empty body and no scan, so a daily run
        // does no work at all once it has caught up.
        sql`(${letters.bodyText} <> '' OR ${letters.scanImageKey} IS NOT NULL)`
      )
    )
    .all()

  const action: RetentionAction = {
    key: 'letters.content',
    label: 'เนื้อหาจดหมายและไฟล์แนบ (คงข้อมูลกำกับไว้)',
    cutoffAt: cutoff,
    rows: rows.length,
    files: 0
  }
  if (rows.length === 0) return action

  const ids = rows.map((r) => r.id)
  const attachments = chunked(ids, (chunk) =>
    db
      .select({ imageKey: letterAttachments.imageKey })
      .from(letterAttachments)
      .where(inArray(letterAttachments.letterId, chunk))
      .all()
  )

  const keys = [
    ...attachments.map((a) => a.imageKey),
    ...rows.map((r) => r.scanImageKey).filter((k): k is string => k !== null)
  ]
  action.files = keys.length
  if (dryRun) return action

  await deleteFiles(keys)
  db.transaction((tx) => {
    for (const chunk of chunks(ids)) {
      tx.delete(letterAttachments).where(inArray(letterAttachments.letterId, chunk)).run()
      tx.update(letters).set({ bodyText: '', scanImageKey: null }).where(inArray(letters.id, chunk)).run()
    }
  })
  return action
}

/* ── payment slips ─────────────────────────────────────────────────────── */

async function purgeSlips(db: Db, cutoff: number, dryRun: boolean): Promise<RetentionAction> {
  const rows = db
    .select({ id: payments.id, key: payments.slipImageKey })
    .from(payments)
    .where(and(lt(payments.createdAt, cutoff), isNotNull(payments.slipImageKey)))
    .all()

  const action: RetentionAction = {
    key: 'payments.slips',
    label: 'ภาพสลิปการโอนเงิน (คงเลขอ้างอิงและยอดไว้)',
    cutoffAt: cutoff,
    rows: rows.length,
    files: rows.length
  }
  if (dryRun || rows.length === 0) return action

  await deleteFiles(rows.map((r) => r.key).filter((k): k is string => k !== null))
  for (const chunk of chunks(rows.map((r) => r.id))) {
    db.update(payments).set({ slipImageKey: null }).where(inArray(payments.id, chunk)).run()
  }
  return action
}

/* ── financial records ─────────────────────────────────────────────────── */

/**
 * Deletes in dependency order inside one transaction with foreign keys on. If
 * anything outside this window still references a row inside it, the whole run
 * aborts rather than leaving a half-purged ledger behind.
 */
function purgeFinancial(db: Db, cutoff: number, dryRun: boolean): RetentionAction {
  const rows =
    countOlder(db, db.select({ n: count() }).from(orders).where(lt(orders.createdAt, cutoff))) +
    countOlder(db, db.select({ n: count() }).from(payments).where(lt(payments.createdAt, cutoff))) +
    countOlder(db, db.select({ n: count() }).from(deposits).where(lt(deposits.createdAt, cutoff)))

  const action: RetentionAction = {
    key: 'financial.records',
    label: 'คำสั่งซื้อ การชำระเงิน และรายการฝากเงิน',
    cutoffAt: cutoff,
    rows,
    files: 0
  }
  if (dryRun || rows === 0) return action

  db.transaction((tx) => {
    tx.delete(deposits).where(lt(deposits.createdAt, cutoff)).run()
    tx.delete(payments).where(lt(payments.createdAt, cutoff)).run()
    // order_items cascade from orders.
    tx.delete(orders).where(lt(orders.createdAt, cutoff)).run()
  })
  return action
}

function purgeVisits(db: Db, cutoff: number, dryRun: boolean): RetentionAction {
  // `visit_date` is a Bangkok wall-clock date string, not an epoch.
  const cutoffDate = bangkokDate(cutoff)
  const action: RetentionAction = {
    key: 'visits.bookings',
    label: 'การจองเยี่ยมญาติ',
    cutoffAt: cutoff,
    rows: countOlder(
      db,
      db.select({ n: count() }).from(visitBookings).where(lt(visitBookings.visitDate, cutoffDate))
    ),
    files: 0
  }
  if (!dryRun && action.rows > 0) {
    db.delete(visitBookings).where(lt(visitBookings.visitDate, cutoffDate)).run()
  }
  return action
}

function purgeAudit(db: Db, cutoff: number, dryRun: boolean): RetentionAction {
  const action: RetentionAction = {
    key: 'audit.logs',
    label: 'บันทึกการใช้งาน (audit log)',
    cutoffAt: cutoff,
    rows: countOlder(
      db,
      db.select({ n: count() }).from(auditLogs).where(lt(auditLogs.createdAt, cutoff))
    ),
    files: 0
  }
  if (!dryRun && action.rows > 0) {
    db.delete(auditLogs).where(lt(auditLogs.createdAt, cutoff)).run()
  }
  return action
}

/* ── closed accounts: anonymize, never cascade-delete ──────────────────── */

function anonymizeClosedAccounts(db: Db, cutoff: number, dryRun: boolean): RetentionAction {
  const rows = db
    .select({ id: customers.id })
    .from(customers)
    .where(
      and(
        isNotNull(customers.closedAt),
        lt(customers.closedAt, cutoff),
        isNull(customers.anonymizedAt)
      )
    )
    .all()

  const action: RetentionAction = {
    key: 'accounts.anonymize',
    label: 'บัญชีที่ขอปิด — ลบข้อมูลส่วนบุคคล คงประวัติการเงินไว้',
    cutoffAt: cutoff,
    rows: rows.length,
    files: 0
  }
  if (dryRun || rows.length === 0) return action

  const at = now()
  db.transaction((tx) => {
    for (const row of rows) {
      tx.update(customers)
        .set({
          // UNIQUE and NOT NULL, so it is replaced rather than cleared — with
          // the row's own id, which is not personal data.
          username: `deleted-${row.id}`,
          phone: '',
          fullName: 'ผู้ใช้ที่ลบบัญชีแล้ว',
          lineIdText: null,
          lineUserId: null,
          lineDisplayName: null,
          linePictureUrl: null,
          lineLinkedAt: null,
          // Unusable by construction: nothing hashes to random bytes.
          passwordHash: randomBytes(32).toString('base64'),
          isBlocked: true,
          anonymizedAt: at
        })
        .where(eq(customers.id, row.id))
        .run()
      tx.delete(customerSessions).where(eq(customerSessions.customerId, row.id)).run()
      tx.delete(notifications).where(eq(notifications.recipientId, row.id)).run()
    }
  })
  return action
}

/* ── housekeeping ──────────────────────────────────────────────────────── */

function housekeeping(db: Db, at: number, dryRun: boolean): RetentionAction {
  const action: RetentionAction = {
    key: 'housekeeping',
    label: 'ล้างรหัส OTP ที่หมดอายุและตัวนับ rate limit',
    cutoffAt: at - DAY,
    rows: 0,
    files: 0
  }
  // Not personal data and not covered by a declared window — it runs on every
  // real pass regardless, because a dead counter is only clutter.
  if (!dryRun) action.rows = purgeOtpChallenges(db) + purgeRateLimits(db)
  return action
}

/* ── account closure ───────────────────────────────────────────────────── */

/**
 * Marks an account closed at the owner's request and cuts every session
 * immediately. The scrub itself waits out `pdpa.retention.closed_account_days`
 * so a mistaken request can still be undone by staff.
 */
export function closeAccount(customerId: string, db: Db = defaultDb()): number {
  const at = now()
  db.transaction((tx) => {
    tx.update(customers)
      .set({ closedAt: at, isBlocked: true })
      .where(and(eq(customers.id, customerId), isNull(customers.closedAt)))
      .run()
    tx.update(customerSessions)
      .set({ revokedAt: at })
      .where(and(eq(customerSessions.customerId, customerId), isNull(customerSessions.revokedAt)))
      .run()
  })
  return at
}

/* ── helpers ───────────────────────────────────────────────────────────── */

type CountQuery = { get(): { n: number } | undefined }
const countOlder = (_db: Db, query: CountQuery): number => query.get()?.n ?? 0

/** SQLite's bound-variable limit is 999; every `IN (…)` goes in slices. */
function* chunks<T>(items: T[], size = 400): Generator<T[]> {
  for (let i = 0; i < items.length; i += size) yield items.slice(i, i + size)
}

function chunked<T, R>(items: T[], run: (chunk: T[]) => R[]): R[] {
  const out: R[] = []
  for (const chunk of chunks(items)) out.push(...run(chunk))
  return out
}

async function deleteFiles(keys: string[]): Promise<void> {
  for (const key of keys) {
    // A file that is already gone is the desired end state, not a failure.
    await storage()
      .delete(key)
      .catch((err) => console.error('[pdpa] file delete failed', key, err))
  }
}
