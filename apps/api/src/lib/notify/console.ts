import fs from 'node:fs'
import path from 'node:path'
import type { Notification, NotifierAdapter } from './types.js'

/**
 * Local substitute for LINE push (§9): logs the payload and appends it to
 * `data/outbox.log` so a dev can read exactly what a relative would receive.
 * Also delegates to the in-app notifier so the in-app list stays populated.
 */
export function createConsoleNotifier(outboxPath: string, inner?: NotifierAdapter): NotifierAdapter {
  fs.mkdirSync(path.dirname(outboxPath), { recursive: true })
  return {
    kind: 'console',
    async send(n: Notification) {
      const line = JSON.stringify({ at: new Date().toISOString(), ...n })
      console.log(`[notify] ${n.kind} → ${n.audience}:${n.recipientId} — ${n.title}`)
      fs.appendFileSync(outboxPath, line + '\n', 'utf8')
      await inner?.send(n)
    }
  }
}
