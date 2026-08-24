import { env } from '../env.js'
import { createDb, runMigrations } from './client.js'

const { db, sqlite } = createDb(env().paths.database)
const started = Date.now()
runMigrations(db)
sqlite.close()
console.log(`✓ migrations applied to ${env().paths.database} (${Date.now() - started}ms)`)
