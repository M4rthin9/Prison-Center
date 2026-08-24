import fs from 'node:fs'
import { env } from '../env.js'
import { createDb, runMigrations } from './client.js'

/**
 * `pnpm db:reset` must stay a 3-second operation — deleting the file and
 * replaying migrations is the fastest reset any database offers. Use it often.
 */
const file = env().paths.database
if (env().isProd) throw new Error('refusing to reset the database with NODE_ENV=production')

for (const f of [file, `${file}-wal`, `${file}-shm`]) {
  if (fs.existsSync(f)) fs.rmSync(f)
}
console.log(`✓ dropped ${file}`)

const { db, sqlite } = createDb(file)
runMigrations(db)
sqlite.close()
console.log('✓ migrations applied — run `pnpm db:seed` next')
