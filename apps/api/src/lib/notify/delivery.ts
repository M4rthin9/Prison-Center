import { eq } from 'drizzle-orm'
import { db as defaultDb, type Db } from '../../db/client.js'
import { notifications } from '../../db/schema/index.js'
import { now } from '../time.js'

/**
 * The `line.push` job writes its outcome back onto the in-app notification row
 * it was raised from, so one row answers both "did the relative see it?" and
 * "did the push go out?" — there is no second delivery table to reconcile.
 */
export function markPushDelivered(notificationId: string | null, db: Db = defaultDb()): void {
  if (!notificationId) return
  db.update(notifications)
    .set({ sentAt: now(), error: null })
    .where(eq(notifications.id, notificationId))
    .run()
}

export function markPushFailed(
  notificationId: string | null,
  message: string,
  db: Db = defaultDb()
): void {
  if (!notificationId) return
  db.update(notifications)
    .set({ error: message.slice(0, 500) })
    .where(eq(notifications.id, notificationId))
    .run()
}
