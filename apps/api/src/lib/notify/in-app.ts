import type { Db } from '../../db/client.js'
import { notifications } from '../../db/schema/index.js'
import type { Notification, NotifierAdapter } from './types.js'

/** Writes to the `notifications` table — the surface the apps read from. */
export function createInAppNotifier(getDb: () => Db, channel: 'in_app' | 'line' = 'in_app'): NotifierAdapter {
  return {
    kind: channel === 'line' ? 'line' : 'in_app',
    async send(n: Notification) {
      getDb()
        .insert(notifications)
        .values({
          audience: n.audience,
          recipientId: n.recipientId,
          kind: n.kind,
          title: n.title,
          body: n.body,
          dataJson: n.data ? JSON.stringify(n.data) : null,
          channel,
          sentAt: Date.now()
        })
        .run()
    }
  }
}
