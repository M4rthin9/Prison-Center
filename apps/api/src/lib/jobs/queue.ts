import { and, asc, eq, lte } from 'drizzle-orm'
import { db as defaultDb, type Db } from '../../db/client.js'
import { jobs, type JobStatus } from '../../db/schema/index.js'
import { MINUTE, now } from '../time.js'

/** Job kinds. Add the kind here before writing its handler. */
export type JobKind =
  | 'session.purge'
  | 'line.push'
  | 'letter.batch_pdf'
  | 'report.generate'
  | 'payment.expire'
  | 'visit.reminder'
  | 'visit.schedule.materialize'
  | 'order.cutoff_notify'
  | 'pdpa.retention'

export interface JobRow {
  id: string
  kind: string
  payload: Record<string, unknown>
  attempts: number
  maxAttempts: number
}

export interface EnqueueOptions {
  runAt?: number
  maxAttempts?: number
  db?: Db
}

export function enqueue(
  kind: JobKind,
  payload: Record<string, unknown> = {},
  opts: EnqueueOptions = {}
): string {
  const db = opts.db ?? defaultDb()
  return db
    .insert(jobs)
    .values({
      kind,
      payloadJson: payload,
      runAt: opts.runAt ?? now(),
      maxAttempts: opts.maxAttempts ?? 5,
      status: 'pending'
    })
    .returning({ id: jobs.id })
    .get().id
}

/**
 * Claim exactly one due job. `BEGIN IMMEDIATE` takes the write lock before the
 * SELECT, so two workers can never hand out the same row — this is the whole
 * reason SQLite is a viable queue at this scale.
 */
export function claimNext(worker: string, db: Db = defaultDb()): JobRow | null {
  return db.transaction(
    (tx) => {
      const at = now()
      const row = tx
        .select()
        .from(jobs)
        .where(and(eq(jobs.status, 'pending'), lte(jobs.runAt, at)))
        .orderBy(asc(jobs.runAt), asc(jobs.id))
        .limit(1)
        .get()
      if (!row) return null

      tx.update(jobs)
        .set({ status: 'running', lockedAt: at, lockedBy: worker, attempts: row.attempts + 1 })
        .where(eq(jobs.id, row.id))
        .run()

      return {
        id: row.id,
        kind: row.kind,
        payload: row.payloadJson ?? {},
        attempts: row.attempts + 1,
        maxAttempts: row.maxAttempts
      }
    },
    { behavior: 'immediate' }
  )
}

export function complete(id: string, result?: unknown, db: Db = defaultDb()) {
  db.update(jobs)
    .set({
      status: 'succeeded' satisfies JobStatus,
      completedAt: now(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      resultJson: result === undefined ? null : JSON.stringify(result)
    })
    .where(eq(jobs.id, id))
    .run()
}

/** Exponential backoff, then park the row as `failed` for a human to look at. */
export function fail(job: JobRow, error: unknown, db: Db = defaultDb()) {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  const exhausted = job.attempts >= job.maxAttempts
  db.update(jobs)
    .set({
      status: exhausted ? 'failed' : 'pending',
      runAt: exhausted ? undefined : now() + Math.min(2 ** job.attempts, 60) * MINUTE,
      lockedAt: null,
      lockedBy: null,
      lastError: message,
      completedAt: exhausted ? now() : null
    })
    .where(eq(jobs.id, job.id))
    .run()
}

/** A worker that died mid-job leaves `running` rows behind; reclaim them. */
export function requeueStale(olderThanMs = 10 * MINUTE, db: Db = defaultDb()) {
  db.update(jobs)
    .set({ status: 'pending', lockedAt: null, lockedBy: null })
    .where(and(eq(jobs.status, 'running'), lte(jobs.lockedAt, now() - olderThanMs)))
    .run()
}
