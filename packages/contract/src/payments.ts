import { z } from 'zod'
import { Ulid } from './common.js'

/* ── vocabulary ────────────────────────────────────────────────────────── */

export const PaymentRail = z.enum([
  'promptpay_bill_payment',
  'promptpay_credit_transfer',
  'bank_transfer'
])
export type PaymentRail = z.infer<typeof PaymentRail>

export const PAYMENT_RAIL_LABEL: Record<PaymentRail, string> = {
  promptpay_bill_payment: 'พร้อมเพย์ — ชำระบิล (tag-30)',
  promptpay_credit_transfer: 'พร้อมเพย์ — โอนเงิน (tag-29)',
  bank_transfer: 'โอนเข้าบัญชีธนาคาร'
}

export const TargetType = z.enum(['mobile', 'national_id', 'ewallet_id', 'bank_account'])
export type TargetType = z.infer<typeof TargetType>

export const TARGET_TYPE_LABEL: Record<TargetType, string> = {
  mobile: 'เบอร์มือถือ',
  national_id: 'เลขประจำตัวประชาชน/ผู้เสียภาษี',
  ewallet_id: 'รหัส e-Wallet',
  bank_account: 'เลขบัญชีธนาคาร'
}

export const RefMode = z.enum(['payment_no', 'inmate_code', 'customer_phone', 'none'])
export type RefMode = z.infer<typeof RefMode>

export const REF_MODE_LABEL: Record<RefMode, string> = {
  payment_no: 'เลขที่รายการชำระเงิน',
  inmate_code: 'รหัสผู้ต้องขัง',
  customer_phone: 'เบอร์ผู้ชำระ',
  none: 'ไม่ใช้'
}

export const PaymentPurpose = z.enum(['order', 'deposit', 'letter_package'])
export type PaymentPurpose = z.infer<typeof PaymentPurpose>

export const PAYMENT_PURPOSE_LABEL: Record<PaymentPurpose, string> = {
  order: 'สั่งซื้อสินค้า',
  deposit: 'ฝากเงินผู้ต้องขัง',
  letter_package: 'แพ็กเกจจดหมาย'
}

export const PaymentState = z.enum([
  'pending',
  'awaiting_verify',
  'succeeded',
  'failed',
  'expired',
  'refunded'
])
export type PaymentState = z.infer<typeof PaymentState>

export const PAYMENT_STATE_LABEL: Record<PaymentState, string> = {
  pending: 'รอชำระเงิน',
  awaiting_verify: 'รอเจ้าหน้าที่ตรวจสอบ',
  succeeded: 'ชำระเงินสำเร็จ',
  failed: 'ชำระเงินไม่สำเร็จ',
  expired: 'หมดอายุ',
  refunded: 'คืนเงินแล้ว'
}

export const VerifyMethod = z.enum(['manual', 'api_lookup', 'statement_match'])
export type VerifyMethod = z.infer<typeof VerifyMethod>

/** Display only — the slip-matching key is `bank_code`, not the name. */
export const THAI_BANKS: Record<string, string> = {
  '002': 'ธนาคารกรุงเทพ',
  '004': 'ธนาคารกสิกรไทย',
  '006': 'ธนาคารกรุงไทย',
  '011': 'ธนาคารทหารไทยธนชาต',
  '014': 'ธนาคารไทยพาณิชย์',
  '025': 'ธนาคารกรุงศรีอยุธยา',
  '030': 'ธนาคารออมสิน',
  '033': 'ธนาคารอาคารสงเคราะห์',
  '034': 'ธ.ก.ส.',
  '069': 'ธนาคารเกียรตินาคินภัทร',
  '073': 'ธนาคารแลนด์ แอนด์ เฮ้าส์'
}

/* ── channels ──────────────────────────────────────────────────────────── */

/** What the customer app is allowed to see. No Biller ID, no proxy value. */
export const PaymentChannelPublic = z.object({
  id: Ulid,
  rail: PaymentRail,
  displayName: z.string(),
  /** Present on `bank_transfer`, where the account *is* the instruction. */
  bankCode: z.string().nullable(),
  bankName: z.string().nullable(),
  accountNo: z.string().nullable(),
  accountName: z.string().nullable(),
  /** True when the charged amount will carry a satang salt (§4.3). */
  amountSaltEnabled: z.boolean(),
  ttlMinutes: z.number().int(),
  note: z.string().nullable()
})
export type PaymentChannelPublic = z.infer<typeof PaymentChannelPublic>

export const PaymentChannel = PaymentChannelPublic.extend({
  prisonId: Ulid.nullable(),
  prisonName: z.string().nullable(),
  priority: z.number().int(),
  isActive: z.boolean(),
  billerId: z.string().nullable(),
  terminalSuffix: z.string().nullable(),
  ref1Mode: RefMode,
  ref2Mode: RefMode,
  targetType: TargetType.nullable(),
  targetValue: z.string().nullable(),
  supportsPurposes: z.array(PaymentPurpose),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type PaymentChannel = z.infer<typeof PaymentChannel>

const ChannelFields = z.object({
  /** NULL = department-wide, super_admin only. */
  prisonId: Ulid.nullable().optional(),
  rail: PaymentRail,
  displayName: z.string().min(1, 'ต้องระบุชื่อช่องทาง').max(80),
  priority: z.number().int().min(0).max(9999).default(100),
  isActive: z.boolean().default(true),
  billerId: z.string().max(20).nullable().optional(),
  terminalSuffix: z.string().max(10).nullable().optional(),
  ref1Mode: RefMode.default('payment_no'),
  ref2Mode: RefMode.default('none'),
  targetType: TargetType.nullable().optional(),
  targetValue: z.string().max(40).nullable().optional(),
  bankCode: z.string().max(5).nullable().optional(),
  accountNo: z.string().max(30).nullable().optional(),
  accountName: z.string().max(120).nullable().optional(),
  supportsPurposes: z.array(PaymentPurpose).min(1).default(['order']),
  amountSaltEnabled: z.boolean().default(false),
  ttlMinutes: z.number().int().min(5).max(1440).default(30),
  note: z.string().max(300).nullable().optional()
})

/**
 * The rails need genuinely different fields, so the shape is validated per
 * rail rather than with a pile of optional columns nobody checks.
 */
export const CreatePaymentChannelInput = ChannelFields.superRefine((v, ctx) => {
  if (v.rail === 'promptpay_bill_payment') {
    // A Biller ID is the 13-digit tax id plus a bank-issued 2-digit suffix.
    // Either half may be typed in its own field or the whole 15 in one.
    const biller = v.billerId?.replace(/\D/g, '') ?? ''
    const suffix = v.terminalSuffix?.replace(/\D/g, '') ?? ''
    const full = biller.length === 15 ? biller : biller + suffix
    if (!/^\d{15}$/.test(full)) {
      ctx.addIssue({
        code: 'custom',
        path: ['billerId'],
        message: 'Biller ID ต้องเป็น 15 หลัก (เลขผู้เสียภาษี 13 หลัก + รหัสท้าย 2 หลัก)'
      })
    }
    if (v.ref1Mode === 'none') {
      ctx.addIssue({
        code: 'custom',
        path: ['ref1Mode'],
        message: 'Ref1 คือกุญแจกระทบยอดของ tag-30 จึงเว้นว่างไม่ได้'
      })
    }
    if (v.amountSaltEnabled) {
      ctx.addIssue({
        code: 'custom',
        path: ['amountSaltEnabled'],
        message: 'ช่องทางชำระบิลใช้ Ref1 อ้างอิงอยู่แล้ว ไม่ต้องเติมเศษสตางค์'
      })
    }
  }
  if (v.rail === 'promptpay_credit_transfer') {
    if (!v.targetType || v.targetType === 'bank_account') {
      ctx.addIssue({
        code: 'custom',
        path: ['targetType'],
        message: 'ต้องระบุพร้อมเพย์ปลายทาง (เบอร์มือถือ / เลขประจำตัว / e-Wallet)'
      })
    }
    if (!v.targetValue) {
      ctx.addIssue({ code: 'custom', path: ['targetValue'], message: 'ต้องระบุพร้อมเพย์ปลายทาง' })
    }
  }
  if (v.rail === 'bank_transfer' && !(v.bankCode && v.accountNo)) {
    ctx.addIssue({
      code: 'custom',
      path: ['accountNo'],
      message: 'การโอนเข้าบัญชีต้องระบุธนาคารและเลขบัญชี'
    })
  }
})
export type CreatePaymentChannelInput = z.infer<typeof ChannelFields>

/** PATCH replaces the whole channel: a half-edited rail is not a valid rail. */
export const UpdatePaymentChannelInput = CreatePaymentChannelInput
export type UpdatePaymentChannelInput = CreatePaymentChannelInput

/* ── payments ──────────────────────────────────────────────────────────── */

export const CreatePaymentInput = z.object({
  /** Omitted means "the highest-priority active channel for this facility". */
  channelId: Ulid.optional()
})
export type CreatePaymentInput = z.infer<typeof CreatePaymentInput>

export const PaymentView = z.object({
  id: Ulid,
  paymentNo: z.string(),
  purpose: PaymentPurpose,
  purposeId: Ulid,
  /** Set when `purpose` is `order`, so the pay screen can name what is bought. */
  orderNo: z.string().nullable(),
  /** The same, for `purpose = deposit`. Exactly one of the two is ever set. */
  depositNo: z.string().nullable(),
  /** Set when `purpose='letter_package'` — the coupon purchase being paid for. */
  letterPurchaseNo: z.string().nullable(),
  rail: PaymentRail,
  channelId: Ulid,
  channelName: z.string(),
  bankCode: z.string().nullable(),
  bankName: z.string().nullable(),
  accountNo: z.string().nullable(),
  accountName: z.string().nullable(),

  amountSatang: z.number().int(),
  amountSaltSatang: z.number().int(),
  /** amount + salt — the number that must be transferred, to the satang. */
  chargeSatang: z.number().int(),

  status: PaymentState,
  qrPayload: z.string().nullable(),
  /** PNG data URL rendered by the API; the client never builds a payload. */
  qrImage: z.string().nullable(),
  qrRef1: z.string().nullable(),
  qrRef2: z.string().nullable(),
  expiresAt: z.number().nullable(),

  slipUrl: z.string().nullable(),
  slipUploadedAt: z.number().nullable(),
  transRef: z.string().nullable(),
  rejectReason: z.string().nullable(),
  createdAt: z.number(),
  settledAt: z.number().nullable()
})
export type PaymentView = z.infer<typeof PaymentView>

/** The p.9 payment list. */
export const PaymentSummary = z.object({
  id: Ulid,
  paymentNo: z.string(),
  purpose: PaymentPurpose,
  purposeId: Ulid,
  orderNo: z.string().nullable(),
  depositNo: z.string().nullable(),
  /** Set when `purpose='letter_package'` — the coupon purchase being paid for. */
  letterPurchaseNo: z.string().nullable(),
  prisonId: Ulid,
  prisonName: z.string().nullable(),
  rail: PaymentRail,
  channelName: z.string(),
  customerId: Ulid,
  customerName: z.string(),
  customerPhone: z.string(),
  amountSatang: z.number().int(),
  chargeSatang: z.number().int(),
  status: PaymentState,
  transRef: z.string().nullable(),
  slipUploadedAt: z.number().nullable(),
  createdAt: z.number(),
  settledAt: z.number().nullable()
})
export type PaymentSummary = z.infer<typeof PaymentSummary>

export const PaymentDetail = PaymentSummary.extend({
  channelId: Ulid,
  bankCode: z.string().nullable(),
  bankName: z.string().nullable(),
  accountNo: z.string().nullable(),
  accountName: z.string().nullable(),
  amountSaltSatang: z.number().int(),
  qrRef1: z.string().nullable(),
  qrRef2: z.string().nullable(),
  expiresAt: z.number().nullable(),
  slipUrl: z.string().nullable(),
  sendingBank: z.string().nullable(),
  receivingBank: z.string().nullable(),
  transferAmountSatang: z.number().int().nullable(),
  transferredAt: z.number().nullable(),
  verifiedBy: z.string().nullable(),
  verifiedByName: z.string().nullable(),
  verifiedAt: z.number().nullable(),
  verifyMethod: VerifyMethod.nullable(),
  rejectReason: z.string().nullable(),
  /** Whatever the mini-QR decoder read off the slip. A hint, never proof. */
  slipHint: z
    .object({
      transRef: z.string().nullable(),
      sendingBank: z.string().nullable(),
      raw: z.string().nullable()
    })
    .nullable()
})
export type PaymentDetail = z.infer<typeof PaymentDetail>

/** What the mini-QR decoder managed to read, returned right after upload. */
export const SlipUploadResult = z.object({
  payment: PaymentView,
  hint: z.object({
    transRef: z.string().nullable(),
    sendingBank: z.string().nullable(),
    decoded: z.boolean()
  })
})
export type SlipUploadResult = z.infer<typeof SlipUploadResult>

/**
 * Everything a human read off the slip. The amount is required and compared
 * for exact equality — that is the rule that rejects a wrong-amount slip.
 */
export const VerifyPaymentInput = z.object({
  transRef: z.string().min(6, 'เลขอ้างอิงรายการสั้นเกินไป').max(60),
  transferAmountSatang: z.number().int().min(1),
  transferredAt: z.number().int().min(1),
  sendingBank: z.string().max(60).nullable().optional(),
  receivingBank: z.string().max(60).nullable().optional(),
  receivingAccountNo: z.string().max(30).nullable().optional()
})
export type VerifyPaymentInput = z.infer<typeof VerifyPaymentInput>

export const RejectPaymentInput = z.object({
  reason: z.string().min(1, 'ต้องระบุเหตุผล').max(300)
})
export type RejectPaymentInput = z.infer<typeof RejectPaymentInput>

export const RefundPaymentInput = RejectPaymentInput
export type RefundPaymentInput = RejectPaymentInput
