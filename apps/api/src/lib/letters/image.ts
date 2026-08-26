import { decodeQrIn, type Attempt } from '../payments/slip.js'

/**
 * The generic pipeline lives in `lib/image.ts` — letters were simply the first
 * caller. Re-exported under the old name so the letter module reads the way it
 * did before news covers needed the same EXIF stripping.
 */
export {
  MAX_ATTACHMENT_BYTES,
  MAX_SCAN_BYTES,
  normalizeImage as normalizeLetterImage,
  type NormalizedImage
} from '../image.js'

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
