import { hostname } from 'node:os'
import { db } from '../../db/client.js'
import { customerRealm, staffRealm } from '../auth/realms.js'
import { MINUTE, now } from '../time.js'
import { claimNext, complete, enqueue, fail, requeueStale, type JobKind, type JobRow } from './queue.js'

export type JobHandler = (job: JobRow) => Promise<unknown> | unknown

/**
 * Handlers are registered here, one per kind. Later phases add their own
 * (letter.batch_pdf, report.generate, payment.expire …) without touching the
 * scheduler itself.
 */
export const handlers: Partial<Record<JobKind, JobHandler>> = {
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
  const housekeeping = setInterval(
    () => {
      try {
        requeueStale()
        enqueue('session.purge')
      } catch (err) {
        console.error('[jobs] housekeeping failed', err)
      }
    },
    60 * MINUTE
  )

  tick.unref()
  housekeeping.unref()

  return {
    stop() {
      clearInterval(tick)
      clearInterval(housekeeping)
    }
  }
}
