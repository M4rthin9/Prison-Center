import { and, desc, eq } from 'drizzle-orm'
import { db as defaultDb, type Db } from '../../db/client.js'
import { customers, notifications } from '../../db/schema/index.js'
import { enqueue } from '../jobs/queue.js'
import type { Notification, NotifierAdapter } from '../notify/types.js'

/**
 * LINE push, layered on top of the in-app notifier rather than replacing it.
 *
 * Two rules make this safe to switch on in production:
 *  1. The in-app row is written **first** and always. A relative who never
 *     linked LINE, or a push that fails forever, still sees the notification
 *     in the app — the notification surface never depends on LINE being up.
 *  2. The push itself is a `line.push` job. Nothing about a slip approval
 *     waits on api.line.me, and a transient 500 gets the queue's backoff
 *     instead of a lost message.
 */
export function createLineNotifier(inner: NotifierAdapter, getDb: () => Db = defaultDb): NotifierAdapter {
  return {
    kind: 'line',

    async send(n: Notification) {
      await inner.send(n)
      if (n.audience !== 'customer') return

      const db = getDb()
      const row = db
        .select({ lineUserId: customers.lineUserId })
        .from(customers)
        .where(eq(customers.id, n.recipientId))
        .get()
      if (!row?.lineUserId) return

      // The in-app row the inner adapter just wrote — the push job updates it
      // with the delivery outcome, so one row tells the whole story.
      const target = db
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.recipientId, n.recipientId), eq(notifications.kind, n.kind)))
        .orderBy(desc(notifications.createdAt), desc(notifications.id))
        .limit(1)
        .get()

      enqueue(
        'line.push',
        {
          to: row.lineUserId,
          title: n.title,
          body: n.body,
          notificationId: target?.id ?? null
        },
        { db, maxAttempts: 4 }
      )
    }
  }
}
