import sharp from 'sharp'
import { badRequest } from './errors.js'

/**
 * Every image this system stores — a bank slip, a photo attached to a letter,
 * a scanned reply sheet, a news cover — goes through here first. Decode and
 * re-encode is what actually strips the EXIF block, and a family photo's EXIF
 * carries the coordinates of the house it was taken in.
 */

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024
export const MAX_SCAN_BYTES = 16 * 1024 * 1024
const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp'])

export interface NormalizedImage {
  buffer: Buffer
  contentType: 'image/jpeg'
  width: number
  height: number
  bytes: number
}

export async function normalizeImage(
  input: Buffer,
  opts: { declaredType?: string; maxEdge?: number; maxBytes?: number; label?: string } = {}
): Promise<NormalizedImage> {
  const label = opts.label ?? 'ไฟล์ภาพ'
  const maxBytes = opts.maxBytes ?? MAX_ATTACHMENT_BYTES
  if (input.byteLength === 0) throw badRequest(`${label}ว่างเปล่า`)
  if (input.byteLength > maxBytes) {
    throw badRequest(`${label}ใหญ่เกิน ${Math.round(maxBytes / 1024 / 1024)} MB`)
  }
  if (opts.declaredType && !ACCEPTED.has(opts.declaredType)) {
    throw badRequest('รองรับเฉพาะไฟล์ภาพ JPEG, PNG หรือ WebP')
  }

  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>
  try {
    meta = await sharp(input, { failOn: 'error' }).metadata()
  } catch {
    throw badRequest(`อ่าน${label}ไม่ได้ — กรุณาถ่ายใหม่`)
  }
  if (!meta.format || !ACCEPTED.has(`image/${meta.format}`)) {
    throw badRequest('รองรับเฉพาะไฟล์ภาพ JPEG, PNG หรือ WebP')
  }

  const edge = opts.maxEdge ?? 1600
  const out = await sharp(input)
    .rotate()
    .resize({ width: edge, height: edge, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 82, mozjpeg: true })
    .toBuffer({ resolveWithObject: true })

  return {
    buffer: out.data,
    contentType: 'image/jpeg',
    width: out.info.width,
    height: out.info.height,
    bytes: out.data.byteLength
  }
}

