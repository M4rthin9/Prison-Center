export interface PutOptions {
  contentType?: string
  /** Logical folder, e.g. `slips/2026-08`. Keys are never guessable. */
  prefix?: string
  filename?: string
}

export interface StoredObject {
  key: string
  size: number
  contentType: string | null
  url: string
}

/**
 * The only file API the rest of the codebase may touch. Never import an S3 SDK
 * (or `fs`) inside a route — if the local path diverges from prod behaviour,
 * that is a bug in this interface.
 */
export interface StorageAdapter {
  readonly kind: 'local' | 's3'
  put(body: Buffer | Uint8Array, opts?: PutOptions): Promise<StoredObject>
  get(key: string): Promise<Buffer>
  delete(key: string): Promise<void>
  exists(key: string): Promise<boolean>
  /** Public (or signed) URL for a stored key. */
  url(key: string): string
}
