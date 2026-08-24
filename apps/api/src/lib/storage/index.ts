import { env } from '../../env.js'
import { createLocalStorage } from './local.js'
import { createS3Storage } from './s3.js'
import type { StorageAdapter } from './types.js'

export type { StorageAdapter, StoredObject, PutOptions } from './types.js'

let instance: StorageAdapter | null = null

export function storage(): StorageAdapter {
  if (instance) return instance
  const e = env()
  instance =
    e.STORAGE_ADAPTER === 's3'
      ? createS3Storage({
          endpoint: e.S3_ENDPOINT,
          region: e.S3_REGION,
          bucket: e.S3_BUCKET,
          accessKeyId: e.S3_ACCESS_KEY_ID,
          secretAccessKey: e.S3_SECRET_ACCESS_KEY
        })
      : createLocalStorage(e.paths.uploads, e.STORAGE_PUBLIC_PATH)
  return instance
}

/** Tests inject a fake here. */
export function setStorage(adapter: StorageAdapter | null) {
  instance = adapter
}
