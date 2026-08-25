import sharp from 'sharp'
import { badRequest } from '../errors.js'
import { decodeQrIn, type Attempt } from '../payments/slip.js'

/**
 * Photos attached to a letter, and photographs of a scanned reply sheet. Same
 * rule as a slip: decode and re-encode, because that is what strips the EXIF
 * block — a family photo's EXIF carries the coordinates of the house it was
 * taken in, and this one is going to be printed and handed to a stranger.
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

export async function normalizeLetterImage(
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

/* ── the reply-form QR (p.6) ───────────────────────────────────────────── */

/**
 * A scanned A4 reply sheet is not a bank slip: the QR is large, near a corner,
 * and the page may have come off the scanner rotated. Whole-page first (that is
 * what a flatbed produces), then the corners the template can put it in.
 */
const SHEET_ATTEMPTS: Attempt[] = [
  { region: null, scale: 1 },
  { region: { left: 0.5, top: 0, width: 0.5, height: 0.3 }, scale: 2 },
  { region: { left: 0, top: 0, width: 0.5, height: 0.3 }, scale: 2 },
  { region: { left: 0, top: 0, width: 1, height: 0.35 }, scale: 2 },
  { region: { left: 0, top: 0.65, width: 1, height: 0.35 }, scale: 2 },
  { region: null, scale: 2 }
]

/** `PCL:{letterNo}` is what the print template encodes. Bare numbers still read. */
export function parseReplyQr(payload: string | null): string | null {
  if (!payload) return null
  const text = payload.trim()
  const match = /^(?:PCL:)?([A-Z]{2,5}-L\d{4}-\d{4})$/i.exec(text)
  return match ? match[1]!.toUpperCase() : null
}

export async function decodeReplyQr(image: Buffer): Promise<string | null> {
  return parseReplyQr(await decodeQrIn(image, SHEET_ATTEMPTS))
}
