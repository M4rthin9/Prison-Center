import { crcHex, findTag, parseTlv, tlv, tlvOpt, verifyCrc, withCrc } from './emvco.js'

/**
 * The two PromptPay rails (§4.3). They share an envelope and share nothing
 * else: tag-30 carries reference fields the bank echoes back, tag-29 carries
 * none at all.
 */

const AID_BILL_PAYMENT = 'A000000677010112' // tag-30
const AID_ANY_ID = 'A000000677010111' // tag-29

const PAYLOAD_FORMAT = '00'
const INIT_METHOD = '01'
const MERCHANT_TAG_29 = '29'
const MERCHANT_TAG_30 = '30'
const CURRENCY = '53'
const AMOUNT = '54'
const COUNTRY = '58'

const THB = '764'
const TH = 'TH'
/** Dynamic: the payload carries an amount and is single-use. */
const DYNAMIC = '12'

/** Baht with exactly two decimals — `฿470.37` is `470.37`, never `470.4`. */
export function amountField(chargeSatang: number): string {
  if (!Number.isSafeInteger(chargeSatang) || chargeSatang <= 0) {
    throw new Error('charge must be a positive integer satang value')
  }
  return (chargeSatang / 100).toFixed(2)
}

/* ── tag-29: credit transfer to a PromptPay proxy ──────────────────────── */

export type ProxyType = 'mobile' | 'national_id' | 'ewallet_id'

/**
 * PromptPay proxies are fixed-width. A mobile number is carried as
 * `0066` + the number without its leading zero (13 chars), which is why a
 * validated Thai phone is a precondition, not a nicety.
 */
export function normalizeProxy(type: ProxyType, raw: string): string {
  const digits = raw.replace(/\D/g, '')
  switch (type) {
    case 'mobile': {
      let local = digits
      if (local.startsWith('66')) local = '0' + local.slice(2)
      if (!/^0\d{9}$/.test(local)) throw new Error('เบอร์พร้อมเพย์ไม่ถูกต้อง')
      return `0066${local.slice(1)}`
    }
    case 'national_id':
      if (!/^\d{13}$/.test(digits)) throw new Error('เลขประจำตัวประชาชน/เลขผู้เสียภาษีต้อง 13 หลัก')
      return digits
    case 'ewallet_id':
      if (!/^\d{15}$/.test(digits)) throw new Error('รหัส e-Wallet ต้อง 15 หลัก')
      return digits
  }
}

export interface CreditTransferInput {
  proxyType: ProxyType
  proxyValue: string
  chargeSatang: number
}

export function buildCreditTransfer(input: CreditTransferInput): string {
  const proxy = normalizeProxy(input.proxyType, input.proxyValue)
  const subTag = { mobile: '01', national_id: '02', ewallet_id: '03' }[input.proxyType]

  const merchant = tlv(MERCHANT_TAG_29, tlv('00', AID_ANY_ID) + tlv(subTag, proxy))

  return withCrc(
    tlv(PAYLOAD_FORMAT, '01') +
      tlv(INIT_METHOD, DYNAMIC) +
      merchant +
      tlv(CURRENCY, THB) +
      tlv(AMOUNT, amountField(input.chargeSatang)) +
      tlv(COUNTRY, TH)
  )
}

/* ── tag-30: bill payment ──────────────────────────────────────────────── */

export interface BillPaymentInput {
  /** 15 digits: the 13-digit tax id plus the bank-issued 2-digit suffix. */
  billerId: string
  ref1: string
  ref2?: string | null
  chargeSatang: number
}

/** Ref fields are uppercase alphanumeric — banks silently mangle anything else. */
export function normalizeRef(raw: string, max = 20): string {
  const cleaned = raw.toUpperCase().replace(/[^0-9A-Z]/g, '')
  if (cleaned.length === 0) throw new Error('reference must contain at least one alphanumeric')
  return cleaned.slice(0, max)
}

export function normalizeBillerId(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (!/^\d{15}$/.test(digits)) throw new Error('Biller ID ต้องเป็นตัวเลข 15 หลัก')
  return digits
}

export function buildBillPayment(input: BillPaymentInput): string {
  const merchant = tlv(
    MERCHANT_TAG_30,
    tlv('00', AID_BILL_PAYMENT) +
      tlv('01', normalizeBillerId(input.billerId)) +
      tlv('02', normalizeRef(input.ref1)) +
      tlvOpt('03', input.ref2 ? normalizeRef(input.ref2) : null)
  )

  return withCrc(
    tlv(PAYLOAD_FORMAT, '01') +
      tlv(INIT_METHOD, DYNAMIC) +
      merchant +
      tlv(CURRENCY, THB) +
      tlv(AMOUNT, amountField(input.chargeSatang)) +
      tlv(COUNTRY, TH)
  )
}

/* ── the mini-QR printed on a slip ─────────────────────────────────────── */

export interface SlipMiniQr {
  /** 3-digit sending bank code, when the payload carries one. */
  sendingBank: string | null
  /** The bank's transaction reference — the uniqueness key for a slip. */
  transRef: string | null
  /** CRC checked out. False means "probably a bad photo", not "forged". */
  crcOk: boolean
  raw: string
}

/**
 * Thai slip mini-QRs are EMVCo-shaped TLV with a `91` CRC field: `00` version,
 * `01` sending bank, `02` transaction reference.
 *
 * This payload is **unsigned plaintext** (§4.3 rule 2). Decoding it saves a
 * human from copying 20 characters off a photograph; it settles nothing. When
 * the shape is unrecognised the raw string comes back and staff type the
 * reference in by hand.
 */
export function parseSlipMiniQr(raw: string): SlipMiniQr {
  const trimmed = raw.trim()
  const tags = parseTlv(trimmed)
  if (!tags) return { sendingBank: null, transRef: null, crcOk: false, raw: trimmed }

  const bank = findTag(tags, '01') ?? null
  const ref = findTag(tags, '02') ?? null

  return {
    sendingBank: bank && /^\d{3}$/.test(bank) ? bank : null,
    transRef: ref && ref.length >= 6 ? ref : null,
    crcOk: verifyCrc(trimmed, '91'),
    raw: trimmed
  }
}

/** Used by the tests to mint a slip mini-QR without a real bank. */
export function buildSlipMiniQr(sendingBank: string, transRef: string): string {
  const body = tlv('00', '000001') + tlv('01', sendingBank) + tlv('02', transRef)
  const head = `${body}9104`
  return `${head}${crcHex(head)}`
}
