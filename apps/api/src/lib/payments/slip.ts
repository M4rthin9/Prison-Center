import sharp from 'sharp'
import * as jsqr from 'jsqr'
import QRCode from 'qrcode'
import { badRequest } from '../errors.js'

/**
 * Everything that happens to a photograph of a bank slip between the phone and
 * the storage adapter. Two jobs: make it small and boring, and try to read the
 * mini-QR so a human does not have to copy a reference off a picture.
 */

export const MAX_SLIP_BYTES = 8 * 1024 * 1024
const MAX_EDGE = 1600
const ACCEPTED = new Set(['image/jpeg', 'image/png', 'image/webp'])

export interface NormalizedSlip {
  buffer: Buffer
  contentType: 'image/jpeg'
  width: number
  height: number
  bytes: number
}

/**
 * Re-encodes to JPEG. That is not a size optimisation — decoding and
 * re-encoding is what strips the EXIF block, and a slip photo's EXIF carries
 * the GPS coordinates of the relative's house.
 */
export async function normalizeSlip(input: Buffer, declaredType?: string): Promise<NormalizedSlip> {
  if (input.byteLength === 0) throw badRequest('ไฟล์สลิปว่างเปล่า')
  if (input.byteLength > MAX_SLIP_BYTES) throw badRequest('ไฟล์สลิปใหญ่เกิน 8 MB')
  if (declaredType && !ACCEPTED.has(declaredType)) {
    throw badRequest('รองรับเฉพาะไฟล์ภาพ JPEG, PNG หรือ WebP')
  }

  let pipeline: ReturnType<typeof sharp>
  let meta: Awaited<ReturnType<ReturnType<typeof sharp>['metadata']>>
  try {
    pipeline = sharp(input, { failOn: 'error' })
    meta = await pipeline.metadata()
  } catch {
    throw badRequest('อ่านไฟล์ภาพไม่ได้ — กรุณาถ่ายสลิปใหม่')
  }
  if (!meta.format || !ACCEPTED.has(`image/${meta.format}`)) {
    throw badRequest('รองรับเฉพาะไฟล์ภาพ JPEG, PNG หรือ WebP')
  }

  const out = await sharp(input)
    // `rotate()` with no argument applies the EXIF orientation before we drop it.
    .rotate()
    .resize({ width: MAX_EDGE, height: MAX_EDGE, fit: 'inside', withoutEnlargement: true })
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

/* ── mini-QR decode ────────────────────────────────────────────────────── */

/** jsqr ships as CJS; the default export lands differently under ESM interop. */
const decodeQr = ((jsqr as unknown as { default?: unknown }).default ??
  jsqr) as typeof import('jsqr').default

export interface Attempt {
  /** Fractional crop of the source, or null for the whole image. */
  region: { left: number; top: number; width: number; height: number } | null
  scale: number
}

/**
 * The mini-QR sits bottom-right on most Thai bank slips and is physically
 * tiny, so a straight decode of a downscaled photo usually fails. Each attempt
 * trades area for resolution; the first hit wins.
 */
const ATTEMPTS: Attempt[] = [
  { region: null, scale: 1 },
  { region: null, scale: 2 },
  { region: { left: 0, top: 0.5, width: 1, height: 0.5 }, scale: 2 },
  { region: { left: 0.4, top: 0.55, width: 0.6, height: 0.45 }, scale: 3 },
  { region: { left: 0, top: 0.55, width: 0.6, height: 0.45 }, scale: 3 }
]

const MAX_DECODE_PIXELS = 4096

/**
 * jsQR reads RGBA and nothing else, while the grayscale pass above leaves one
 * byte per pixel. Widening here rather than asking sharp for colour keeps the
 * contrast work on a single channel.
 */
function toRgba(raw: Buffer, channels: number): Uint8ClampedArray {
  if (channels === 4) return new Uint8ClampedArray(raw)
  const px = raw.length / channels
  const out = new Uint8ClampedArray(px * 4)
  for (let i = 0; i < px; i++) {
    const s = i * channels
    out[i * 4] = raw[s]!
    out[i * 4 + 1] = channels >= 3 ? raw[s + 1]! : raw[s]!
    out[i * 4 + 2] = channels >= 3 ? raw[s + 2]! : raw[s]!
    out[i * 4 + 3] = 255
  }
  return out
}

export const decodeMiniQr = (image: Buffer) => decodeQrIn(image, ATTEMPTS)

/**
 * The generic pass: try each crop-and-upscale attempt in order, first hit wins.
 * Phase 4 reuses it for the reply-form QR, which sits somewhere else entirely.
 */
export async function decodeQrIn(image: Buffer, attempts: Attempt[]): Promise<string | null> {
  const meta = await sharp(image).metadata()
  const srcW = meta.width ?? 0
  const srcH = meta.height ?? 0
  if (srcW === 0 || srcH === 0) return null

  for (const attempt of attempts) {
    try {
      let pipeline = sharp(image).rotate()
      let w = srcW
      let h = srcH

      if (attempt.region) {
        const left = Math.floor(srcW * attempt.region.left)
        const top = Math.floor(srcH * attempt.region.top)
        w = Math.max(1, Math.floor(srcW * attempt.region.width))
        h = Math.max(1, Math.floor(srcH * attempt.region.height))
        pipeline = pipeline.extract({
          left,
          top,
          width: Math.min(w, srcW - left),
          height: Math.min(h, srcH - top)
        })
      }

      const targetW = Math.min(MAX_DECODE_PIXELS, Math.round(w * attempt.scale))
      const { data, info } = await pipeline
        .resize({ width: targetW, kernel: 'lanczos3' })
        // Grayscale + normalise: a phone photo of thermal paper is low contrast.
        .grayscale()
        .normalise()
        .raw()
        .toBuffer({ resolveWithObject: true })

      const hit = decodeQr(toRgba(data, info.channels), info.width, info.height, {
        inversionAttempts: 'attemptBoth'
      })
      if (hit?.data) return hit.data
    } catch {
      // A crop that falls outside the image is not an error worth surfacing —
      // it just means this attempt had nothing to look at.
    }
  }
  return null
}

/* ── payment QR rendering ──────────────────────────────────────────────── */

/**
 * The API renders the QR, not the client. A front end that builds its own
 * payload is a front end that can get the amount wrong.
 */
export async function qrDataUrl(payload: string, width = 512): Promise<string> {
  return QRCode.toDataURL(payload, {
    width,
    margin: 2,
    errorCorrectionLevel: 'M',
    color: { dark: '#000000', light: '#FFFFFF' }
  })
}

export async function qrPngBuffer(payload: string, width = 512): Promise<Buffer> {
  return QRCode.toBuffer(payload, { type: 'png', width, margin: 2, errorCorrectionLevel: 'M' })
}
