import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { env } from '../env.js'
import * as schema from './schema/index.js'

export type Db = ReturnType<typeof drizzle<typeof schema>>
export type Sqlite = Database.Database

/**
 * One writer process, WAL, synchronous transactions. Do not run this API under
 * `cluster` or with multiple replicas — that is the one thing this design
 * cannot survive (§10).
 */
export function openSqlite(file: string): Sqlite {
  const memory = file === ':memory:'
  if (!memory) fs.mkdirSync(path.dirname(file), { recursive: true })

  const sqlite = new Database(file)
  sqlite.pragma('foreign_keys = ON')
  if (!memory) sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('busy_timeout = 5000')
  sqlite.pragma('synchronous = NORMAL')
  // Keeps the WAL from growing without bound under a steady write load.
  if (!memory) sqlite.pragma('wal_autocheckpoint = 1000')
  return sqlite
}

export function createDb(file: string): { db: Db; sqlite: Sqlite } {
  const sqlite = openSqlite(file)
  return { db: drizzle(sqlite, { schema, casing: 'snake_case' }), sqlite }
}

export function runMigrations(db: Db, migrationsFolder = env().paths.migrations) {
  migrate(db, { migrationsFolder })
}

let instance: { db: Db; sqlite: Sqlite } | null = null

export function db(): Db {
  return (instance ??= createDb(env().paths.database)).db
}

export function sqlite(): Sqlite {
  return (instance ??= createDb(env().paths.database)).sqlite
}

/** `PRAGMA optimize` on the way out — cheap, and it keeps the planner honest. */
export function closeDb() {
  if (!instance) return
  try {
    instance.sqlite.pragma('optimize')
  } finally {
    instance.sqlite.close()
    instance = null
  }
}

export { schema }
