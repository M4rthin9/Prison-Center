import type { StorageAdapter } from './types.js'

/**
 * Placeholder for the MinIO/S3 adapter (§9). It is deliberately a hard failure
 * rather than a silent fallback: if `STORAGE_ADAPTER=s3` is set in production
 * and the SDK is not wired, the process must not come up pretending to store
 * files.
 *
 * To implement: add `@aws-sdk/client-s3`, keep every SDK import inside this
 * file, and satisfy the same StorageAdapter contract the local adapter does.
 */
export function createS3Storage(_config: {
  endpoint?: string
  region?: string
  bucket?: string
  accessKeyId?: string
  secretAccessKey?: string
}): StorageAdapter {
  throw new Error(
    'STORAGE_ADAPTER=s3 is not implemented yet — see apps/api/src/lib/storage/s3.ts. Use STORAGE_ADAPTER=local.'
  )
}
