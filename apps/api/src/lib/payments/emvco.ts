/**
 * EMVCo QR — the TLV primitives shared by both PromptPay rails and by the
 * mini-QR printed on a bank slip. Nothing here talks to the database, and
 * nothing here is a security boundary: an EMVCo payload is plaintext and
 * unsigned, so a parsed value is a *lookup key*, never proof of anything.
 */

export interface Tlv {
  id: string
  value: string
}

/** `ID (2) | LEN (2) | VALUE` — length is characters, not bytes. */
export function tlv(id: string, value: string): string {
  if (id.length !== 2) throw new Error(`EMVCo tag must be 2 chars, got "${id}"`)
  const len = value.length
  if (len > 99) throw new Error(`EMVCo value for tag ${id} exceeds 99 chars`)
  return `${id}${String(len).padStart(2, '0')}${value}`
}

/** Skips empty values so an absent Ref2 does not emit `0300`. */
export const tlvOpt = (id: string, value: string | null | undefined): string =>
  value ? tlv(id, value) : ''

/**
 * Parses a flat TLV string. Returns `null` on any structural problem rather
 * than throwing — the input is a photograph of a piece of paper.
 */
export function parseTlv(input: string): Tlv[] | null {
  const out: Tlv[] = []
  let i = 0
  while (i < input.length) {
    if (i + 4 > input.length) return null
    const id = input.slice(i, i + 2)
    const lenRaw = input.slice(i + 2, i + 4)
    if (!/^\d{2}$/.test(lenRaw)) return null
    const len = Number(lenRaw)
    const end = i + 4 + len
    if (end > input.length) return null
    out.push({ id, value: input.slice(i + 4, end) })
    i = end
  }
  return out.length > 0 ? out : null
}

export const findTag = (tags: Tlv[], id: string): string | undefined =>
  tags.find((t) => t.id === id)?.value

/* ── CRC ───────────────────────────────────────────────────────────────── */

/** CRC-16/CCITT-FALSE — poly 0x1021, init 0xFFFF, no reflection, no final xor. */
export function crc16(input: string): number {
  let crc = 0xffff
  for (let i = 0; i < input.length; i++) {
    crc ^= input.charCodeAt(i) << 8
    for (let bit = 0; bit < 8; bit++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc
}

export const crcHex = (input: string): string =>
  crc16(input).toString(16).toUpperCase().padStart(4, '0')

/**
 * Appends the CRC field. The checksum covers everything up to and including
 * the `6304` header of the field itself — a detail every wrong implementation
 * gets wrong.
 */
export function withCrc(body: string, crcTag = '63'): string {
  const head = `${body}${crcTag}04`
  return `${head}${crcHex(head)}`
}

/** True when the payload's trailing CRC field matches its own body. */
export function verifyCrc(payload: string, crcTag = '63'): boolean {
  const marker = `${crcTag}04`
  const at = payload.lastIndexOf(marker)
  if (at < 0 || at + 8 !== payload.length) return false
  return crcHex(payload.slice(0, at + 4)) === payload.slice(at + 4).toUpperCase()
}
