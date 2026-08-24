import fs from 'node:fs/promises'
import path from 'node:path'
import { newId } from '../ids.js'
import { bangkokMonth } from '../time.js'
import type { PutOptions, StorageAdapter, StoredObject } from './types.js'

/** Refuses anything that could escape the root — keys come from user input. */
function safeJoin(root: string, key: string) {
  const full = path.resolve(root, key)
  const rel = path.relative(root, full)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error(`invalid storage key: ${key}`)
  return full
}

export function createLocalStorage(root: string, publicPath: string): StorageAdapter {
  return {
    kind: 'local',

    async put(body, opts: PutOptions = {}): Promise<StoredObject> {
      const ext = opts.filename ? path.extname(opts.filename).toLowerCase() : ''
      const prefix = opts.prefix ?? 'misc'
      const key = `${prefix}/${bangkokMonth()}/${newId()}${ext}`
      const full = safeJoin(root, key)
      await fs.mkdir(path.dirname(full), { recursive: true })
      await fs.writeFile(full, body)
      return {
        key,
        size: body.byteLength,
        contentType: opts.contentType ?? null,
        url: `${publicPath}/${key}`
      }
    },

    get: (key) => fs.readFile(safeJoin(root, key)),

    async delete(key) {
      await fs.rm(safeJoin(root, key), { force: true })
    },

    async exists(key) {
      try {
        await fs.access(safeJoin(root, key))
        return true
      } catch {
        return false
      }
    },

    url: (key) => `${publicPath}/${key}`
  }
}
