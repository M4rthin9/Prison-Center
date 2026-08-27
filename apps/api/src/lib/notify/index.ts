import { db } from '../../db/client.js'
import { env } from '../../env.js'
import { createLineNotifier } from '../line/notifier.js'
import { createConsoleNotifier } from './console.js'
import { createInAppNotifier } from './in-app.js'
import type { Notification, NotifierAdapter } from './types.js'

export type { Notification, NotifierAdapter, NotificationKind } from './types.js'

let instance: NotifierAdapter | null = null

export function notifier(): NotifierAdapter {
  if (instance) return instance
  const e = env()
  const inApp = createInAppNotifier(db, e.NOTIFIER_ADAPTER === 'line' ? 'line' : 'in_app')
  instance =
    e.NOTIFIER_ADAPTER === 'console'
      ? createConsoleNotifier(e.paths.outbox, inApp)
      : e.NOTIFIER_ADAPTER === 'line'
        ? createLineNotifier(inApp, db)
        : inApp
  return instance
}

export function setNotifier(adapter: NotifierAdapter | null) {
  instance = adapter
}

/** Notifications must never fail the request that raised them. */
export async function notify(n: Notification): Promise<void> {
  try {
    await notifier().send(n)
  } catch (err) {
    console.error('[notify] delivery failed', n.kind, err)
  }
}
