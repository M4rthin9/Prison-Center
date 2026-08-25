import type { Db } from '../client.js'
import { paymentChannels } from '../schema/index.js'
import type { PaymentPurpose } from '../schema/index.js'

/**
 * Both rails on a fresh database (decision #4). tag-29 is the one that works on
 * launch day; tag-30 is the preferred rail and needs a real Biller ID, so the
 * seeded one is department-wide, deactivated, and obviously fake.
 */

const ORDER_ONLY: PaymentPurpose[] = ['order']
const EVERYTHING: PaymentPurpose[] = ['order', 'deposit', 'letter_package']

interface SeedChannel {
  /** Prison code, or null for a department-wide channel. */
  prison: string | null
  values: Omit<typeof paymentChannels.$inferInsert, 'prisonId'>
}

const CHANNELS: SeedChannel[] = [
  {
    prison: 'KLP',
    values: {
      rail: 'promptpay_credit_transfer',
      displayName: 'พร้อมเพย์ร้านค้าสงเคราะห์ (คลองเปรม)',
      priority: 10,
      targetType: 'mobile',
      targetValue: '0812223333',
      bankCode: '006',
      accountNo: '123-4-56789-0',
      accountName: 'เรือนจำกลางคลองเปรม (ร้านค้าสงเคราะห์)',
      supportsPurposesJson: EVERYTHING,
      // No reference fields on tag-29 — the salted satang is the reference.
      amountSaltEnabled: true,
      ttlMinutes: 30,
      note: 'โอนยอดให้ตรงทุกสตางค์ รวมเศษสตางค์ท้ายยอด'
    }
  },
  {
    prison: 'BKW',
    values: {
      rail: 'promptpay_credit_transfer',
      displayName: 'พร้อมเพย์ร้านค้าสงเคราะห์ (บางขวาง)',
      priority: 10,
      targetType: 'national_id',
      targetValue: '0994000123456',
      bankCode: '014',
      accountNo: '987-6-54321-0',
      accountName: 'เรือนจำกลางบางขวาง (ร้านค้าสงเคราะห์)',
      supportsPurposesJson: EVERYTHING,
      amountSaltEnabled: true,
      ttlMinutes: 30
    }
  },
  {
    prison: 'KLP',
    values: {
      rail: 'bank_transfer',
      displayName: 'โอนเข้าบัญชีธนาคาร (คลองเปรม)',
      priority: 90,
      targetType: 'bank_account',
      bankCode: '002',
      accountNo: '111-2-33333-4',
      accountName: 'เรือนจำกลางคลองเปรม',
      supportsPurposesJson: ORDER_ONLY,
      amountSaltEnabled: true,
      ttlMinutes: 120,
      note: 'โอนแล้วแนบสลิปเพื่อให้เจ้าหน้าที่ตรวจสอบ'
    }
  },
  {
    prison: null,
    values: {
      rail: 'promptpay_bill_payment',
      displayName: 'ชำระบิลกรมราชทัณฑ์ (ส่วนกลาง)',
      priority: 1,
      // Placeholder Biller ID: 13-digit tax id + 2-digit bank suffix. Switch it
      // on once the Department's real one exists (§13 unknown #2).
      billerId: '099400012345601',
      terminalSuffix: '01',
      ref1Mode: 'payment_no',
      ref2Mode: 'inmate_code',
      bankCode: '006',
      accountName: 'กรมราชทัณฑ์',
      supportsPurposesJson: EVERYTHING,
      amountSaltEnabled: false,
      ttlMinutes: 60,
      isActive: false,
      note: 'รอ Biller ID จริงจากธนาคาร'
    }
  }
]

export function seedPaymentChannels(db: Db, prisonIds: Record<string, string>) {
  const ids: string[] = []
  for (const c of CHANNELS) {
    ids.push(
      db
        .insert(paymentChannels)
        .values({ ...c.values, prisonId: c.prison ? prisonIds[c.prison]! : null })
        .returning({ id: paymentChannels.id })
        .get().id
    )
  }
  return { channels: ids.length }
}
