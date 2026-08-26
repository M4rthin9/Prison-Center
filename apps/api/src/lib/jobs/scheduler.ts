import { hostname } from 'node:os'
import { db } from '../../db/client.js'
import { customerRealm, staffRealm } from '../auth/realms.js'
import { expireDuePayments } from '../../modules/payments/service.js'
import { markBatchFailed, renderBatch } from '../../modules/letters/service.js'
import { materializeAll, sendVisitReminders } from '../../modules/visits/service.js'
import { generateReport } from '../../modules/reports/service.js'
import { MINUTE, now } from '../time.js'
import {
  claimNext,
  complete,
  enqueue,
  fail,
  requeueStale,
  type JobKind,
  type JobRow
} from './queue.js'

export type JobHandler = (job: JobRow) => Promise<unknown> | unknown

/**
 * Handlers are registered here, one per kind. Later phases add their own
 * (letter.batch_pdf, report.generate, payment.expire …) without touching the
 * scheduler itself.
 */
export const handlers: Partial<Record<JobKind, JobHandler>> = {
  // A QR whose window has closed must stop being payable — but only while it
  // is still `pending`. A payment with a slip on it is waiting on staff.
  'payment.expire': () => ({ expired: expireDuePayments() }),

  // The A4 batch PDF (§4.5). Off the request thread on purpose: a browser
  // starting up must never be something a staff member waits on.
  'letter.batch_pdf': async (job) => {
    const batchId = String(job.payload.batchId ?? '')
    try {
      return await renderBatch(batchId)
    } catch (err) {
      // Park the failure on the batch as well as the job row, so the operator
      // sees it on the screen they are actually looking at.
      markBatchFailed(batchId, err instanceof Error ? err.message : String(err))
      throw err
    }
  },

  // §4.6: the template becomes rows N weeks ahead. Idempotent, and it never
  // touches a row a staff member has edited — so it is safe to run hourly.
  'visit.schedule.materialize': () => materializeAll(),

  'visit.reminder': () => sendVisitReminders(),

  // §7: seven XLSX reports, all off the request thread. The job row *is* the
  // record — its payload holds the filters and its result holds the file key,
  // so a report can always be traced back to what was asked for.
  'report.generate': (job) => generateReport(job.id),

  'session.purge': () => {
    const at = now()
    customerRealm.purgeExpiredSessions(db(), at)
    staffRealm.purgeExpiredSessions(db(), at)
    return { purgedAt: at }
  }
}

export function registerHandler(kind: JobKind, handler: JobHandler) {
  handlers[kind] = handler
}

const WORKER = `${hostname()}:${process.pid}`

async function runOne(): Promise<boolean> {
  const job = claimNext(WORKER)
  if (!job) return false

  const handler = handlers[job.kind as JobKind]
  if (!handler) {
    fail(job, new Error(`ไม่มี handler สำหรับงานชนิด "${job.kind}"`))
    return true
  }

  try {
    complete(job.id, await handler(job))
  } catch (err) {
    console.error(`[jobs] ${job.kind} #${job.id} failed (attempt ${job.attempts})`, err)
    fail(job, err)
  }
  return true
}

/** Drains every due job. Exported so tests can run the queue deterministically. */
export async function drainJobs(limit = 100): Promise<number> {
  let n = 0
  while (n < limit && (await runOne())) n++
  return n
}

export interface Scheduler {
  stop(): void
}

/**
 * In-process scheduler: no Redis, no separate worker container. Safe precisely
 * because there is exactly one API process (§10).
 */
export function startScheduler(intervalMs = 5_000): Scheduler {
  let running = false

  const tick = setInterval(async () => {
    if (running) return
    running = true
    try {
      await drainJobs(25)
    } catch (err) {
      console.error('[jobs] scheduler tick failed', err)
    } finally {
      running = false
    }
  }, intervalMs)

  // Housekeeping: reclaim jobs orphaned by a crash, and keep the session tables
  // from growing forever.
  const housekeeping = setInterval(() => {
    try {
      requeueStale()
      enqueue('session.purge')
      enqueue('visit.schedule.materialize')
      enqueue('visit.reminder')
    } catch (err) {
      console.error('[jobs] housekeeping failed', err)
    }
  }, 60 * MINUTE)

  tick.unref()
  housekeeping.unref()

  return {
    stop() {
      clearInterval(tick)
      clearInterval(housekeeping)
    }
  }
}
