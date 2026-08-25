import { and, eq, ne } from 'drizzle-orm'
import type { DbOrTx } from '../../db/client.js'
import { payments } from '../../db/schema/index.js'
import type { PaymentRail, VerifyMethod } from '../../db/schema/payments.js'
import { formatBaht } from '../money.js'
import { MINUTE } from '../time.js'

/**
 * The verification seam (decision #2). Launch runs `ManualVerifier`: a human
 * looks at the slip and types what they see, and these rules decide whether
 * what they typed can settle the payment. An aggregator later is a second
 * implementation of this interface plus a settings key — not a refactor.
 */

/** What a slip claims. Whoever produced it — a human or an API — fills this in. */
export interface SlipEvidence {
  /** The bank's transaction reference. The uniqueness key for a slip. */
  transRef: string
  transferAmountSatang: number
  transferredAt: number
  sendingBank?: string | null
  receivingBank?: string | null
  receivingAccountNo?: string | null
}

export interface PaymentFacts {
  id: string
  rail: PaymentRail
  chargeSatang: number
  createdAt: number
  expiresAt: number | null
  channelBankCode: string | null
  channelAccountNo: string | null
}

export interface VerifyOptions {
  /** How late after expiry a transfer may still be honoured. */
  graceMinutes: number
  /** Off by default: the receiving bank on a slip photo is free text. */
  requireBankMatch: boolean
}

export interface VerifyOutcome {
  ok: boolean
  /** Thai, customer-readable — these strings reach the rejection notice. */
  failures: string[]
}

export interface SlipVerifier {
  readonly method: VerifyMethod
  check(
    payment: PaymentFacts,
    evidence: SlipEvidence,
    opts: VerifyOptions,
    db: DbOrTx
  ): VerifyOutcome
}

/** Normalised the same way on write and on lookup, or uniqueness is a lie. */
export const normalizeTransRef = (raw: string): string =>
  raw.trim().toUpperCase().replace(/\s+/g, '')

/**
 * §4.3 rule 1. The UNIQUE index on `payments.trans_ref` is the real guarantee;
 * this lookup exists so the staff member gets a sentence instead of a 500.
 */
export function transRefTaken(transRef: string, exceptPaymentId: string, db: DbOrTx): boolean {
  const hit = db
    .select({ id: payments.id, paymentNo: payments.paymentNo })
    .from(payments)
    .where(and(eq(payments.transRef, transRef), ne(payments.id, exceptPaymentId)))
    .get()
  return !!hit
}

export const manualVerifier: SlipVerifier = {
  method: 'manual',

  check(payment, evidence, opts, db) {
    const failures: string[] = []
    const transRef = normalizeTransRef(evidence.transRef)

    if (transRef.length < 6) {
      failures.push('เลขอ้างอิงรายการ (trans ref) สั้นเกินไป')
    } else if (transRefTaken(transRef, payment.id, db)) {
      // One slip settles exactly one payment. This is the anti-fraud mechanism.
      failures.push('สลิปนี้ถูกใช้ยืนยันการชำระเงินรายการอื่นไปแล้ว')
    }

    // §4.3 rule 3: exact integer satang. No tolerance window, ever — a
    // tolerance is an invitation to pay ฿1 less than the salted amount.
    if (evidence.transferAmountSatang !== payment.chargeSatang) {
      failures.push(
        `ยอดโอนไม่ตรง — สลิประบุ ${formatBaht(evidence.transferAmountSatang)} ` +
          `แต่ต้องชำระ ${formatBaht(payment.chargeSatang)}`
      )
    }

    // §4.3 rule 4: a valid, unused slip from an unrelated transfer is the
    // obvious attack, so the transfer has to have happened inside this
    // payment's own window.
    const floor = payment.createdAt - 5 * MINUTE
    const ceiling = (payment.expiresAt ?? payment.createdAt) + opts.graceMinutes * MINUTE
    if (evidence.transferredAt < floor) {
      failures.push('เวลาโอนตามสลิปอยู่ก่อนการสร้างรายการชำระเงินนี้')
    } else if (evidence.transferredAt > ceiling) {
      failures.push('เวลาโอนตามสลิปเลยกำหนดชำระของรายการนี้แล้ว')
    }

    if (opts.requireBankMatch) {
      if (payment.channelBankCode && evidence.receivingBank) {
        if (normalizeTransRef(evidence.receivingBank) !== payment.channelBankCode.toUpperCase()) {
          failures.push('ธนาคารปลายทางตามสลิปไม่ตรงกับบัญชีของช่องทางนี้')
        }
      }
      if (payment.channelAccountNo && evidence.receivingAccountNo) {
        const last4 = (s: string) => s.replace(/\D/g, '').slice(-4)
        if (last4(evidence.receivingAccountNo) !== last4(payment.channelAccountNo)) {
          failures.push('เลขบัญชีปลายทางตามสลิปไม่ตรงกับบัญชีของช่องทางนี้')
        }
      }
    }

    return { ok: failures.length === 0, failures }
  }
}

/**
 * Resolved from settings when `verify_method` becomes configurable. Today
 * there is exactly one implementation and that is the point (decision #2).
 */
export function verifierFor(_method: VerifyMethod = 'manual'): SlipVerifier {
  return manualVerifier
}
