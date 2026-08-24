import { serve } from '@hono/node-server'
import { createApp, API_PREFIX } from './app.js'
import { closeDb, db, runMigrations } from './db/client.js'
import { env } from './env.js'
import { startScheduler } from './lib/jobs/scheduler.js'

const e = env()

// Migrations run at boot: one writer process, so there is no window where two
// instances race the schema, and `pnpm dev` never needs a separate step.
runMigrations(db())

const app = createApp()
const scheduler = startScheduler()

const server = serve({ fetch: app.fetch, port: e.PORT }, (info) => {
  console.log(`▲ api        http://localhost:${info.port}`)
  console.log(`  health     http://localhost:${info.port}/health`)
  console.log(`  openapi    http://localhost:${info.port}${API_PREFIX}/openapi.json`)
  console.log(`  database   ${e.paths.database}`)
  console.log(`  storage    ${e.STORAGE_ADAPTER} · notifier ${e.NOTIFIER_ADAPTER}`)
})

let closing = false
function shutdown(signal: string) {
  if (closing) return
  closing = true
  console.log(`\n${signal} — shutting down`)
  scheduler.stop()
  server.close(() => {
    closeDb() // runs PRAGMA optimize
    process.exit(0)
  })
  // Never hang a deploy on a stuck keep-alive connection.
  setTimeout(() => process.exit(1), 10_000).unref()
}

process.on('SIGINT', () => shutdown('SIGINT'))
process.on('SIGTERM', () => shutdown('SIGTERM'))
