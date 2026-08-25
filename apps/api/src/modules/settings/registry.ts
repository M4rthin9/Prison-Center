import { z } from 'zod'

/**
 * The Settings Registry: every key is declared here with a Zod schema and a
 * default. Unknown keys are rejected on write; missing rows fall back to the
 * declared default, so a fresh database is fully configured.
 *
 * `scope: 'prison'` keys may be overridden per facility; `'global'` keys may not.
 * `exposed: true` keys are readable by the customer app via /settings/public.
 */
export interface SettingDef<T> {
  schema: z.ZodType<T>
  default: T
  scope: 'global' | 'prison'
  exposed: boolean
  label: string
}

const def = <T>(
  schema: z.ZodType<T>,
  value: T,
  opts: { scope?: 'global' | 'prison'; exposed?: boolean; label: string }
): SettingDef<T> => ({
  schema,
  default: value,
  scope: opts.scope ?? 'global',
  exposed: opts.exposed ?? false,
  label: opts.label
})

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'ต้องเป็นรูปแบบ HH:MM')

const DayHours = z.object({
  weekday: z.number().int().min(0).max(6),
  opensAt: HHMM,
  closesAt: HHMM,
  isOpen: z.boolean()
})

export const REGISTRY = {
  'contact.phone': def(z.string().max(40), '02-000-0000', {
    exposed: true,
    scope: 'prison',
    label: 'เบอร์ติดต่อ'
  }),
  'contact.email': def(z.string().max(120), 'support@example.go.th', {
    exposed: true,
    scope: 'prison',
    label: 'อีเมลติดต่อ'
  }),
  'contact.line_official': def(z.string().max(60), '@prisoncenter', {
    exposed: true,
    scope: 'prison',
    label: 'บัญชี LINE ทางการ'
  }),
  'contact.address_th': def(z.string().max(400), '', {
    exposed: true,
    scope: 'prison',
    label: 'ที่อยู่'
  }),

  'shop.hours': def(
    z.array(DayHours).length(7),
    [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
      weekday,
      opensAt: '08:30',
      closesAt: '16:30',
      isOpen: weekday !== 0
    })),
    { scope: 'prison', exposed: true, label: 'เวลาทำการร้านค้า' }
  ),
  'order.cutoff_time': def(HHMM, '15:00', {
    scope: 'prison',
    exposed: true,
    label: 'เวลาปิดรับคำสั่งซื้อประจำวัน'
  }),
  // Off by default so a fresh install (and every dev machine at 22:00) can
  // place an order. Turn it on per facility once the real hours are entered.
  'order.enforce_shop_hours': def(z.boolean(), false, {
    scope: 'prison',
    exposed: true,
    label: 'บังคับเวลาทำการร้านค้าและเวลาปิดรับคำสั่งซื้อ'
  }),
  'order.max_lines': def(z.number().int().min(1).max(50), 50, {
    scope: 'prison',
    exposed: true,
    label: 'จำนวนรายการสูงสุดต่อคำสั่งซื้อ'
  }),

  'visit.horizon_weeks': def(z.number().int().min(1).max(12), 4, {
    scope: 'prison',
    exposed: true,
    label: 'จำนวนสัปดาห์ที่เปิดให้จองล่วงหน้า'
  }),
  'visit.booking_cutoff_hours': def(z.number().int().min(0).max(168), 24, {
    scope: 'prison',
    exposed: true,
    label: 'ปิดรับจองก่อนเวลาเยี่ยม (ชั่วโมง)'
  }),

  'letter.packages': def(
    z.array(
      z.object({
        name: z.string(),
        direction: z.enum(['to_prison', 'to_home']),
        priceSatang: z.number().int().min(0),
        quota: z.number().int().min(1)
      })
    ),
    [
      {
        name: 'แพ็กเกจ 10 ฉบับ (ส่งเข้าเรือนจำ)',
        direction: 'to_prison',
        priceSatang: 10000,
        quota: 10
      },
      { name: 'แพ็กเกจ 10 ฉบับ (ส่งกลับบ้าน)', direction: 'to_home', priceSatang: 10000, quota: 10 }
    ],
    { label: 'แพ็กเกจจดหมายอิเล็กทรอนิกส์' }
  ),

  'payment.channel_default': def(z.string().nullable(), null, {
    scope: 'prison',
    label: 'ช่องทางชำระเงินเริ่มต้น'
  }),
  'payment.qr.ttl_minutes': def(z.number().int().min(5).max(1440), 30, {
    exposed: true,
    label: 'อายุ QR ชำระเงิน (นาที)'
  }),
  'payment.salt.enabled': def(z.boolean(), true, {
    label: 'เติมเศษสตางค์เพื่อกระทบยอด (PromptPay tag-29)'
  }),

  'inmate.sync.source': def(z.string().max(60), 'doc_xlsx', {
    label: 'แหล่งข้อมูลผู้ต้องขัง'
  }),

  // Declared from Phase 0 so the Phase 7 retention job touches nothing else.
  // Values need departmental sign-off before the job is enabled.
  'pdpa.retention.letter_days': def(z.number().int().min(30), 365, {
    label: 'เก็บเนื้อหาจดหมาย (วัน)'
  }),
  'pdpa.retention.slip_days': def(z.number().int().min(365), 1825, {
    label: 'เก็บภาพสลิป (วัน)'
  }),
  'pdpa.retention.financial_days': def(z.number().int().min(365), 1825, {
    label: 'เก็บรายการการเงิน (วัน)'
  }),
  'pdpa.retention.visit_days': def(z.number().int().min(90), 730, {
    label: 'เก็บข้อมูลการเยี่ยม (วัน)'
  }),
  'pdpa.retention.audit_days': def(z.number().int().min(365), 1825, {
    label: 'เก็บ audit log (วัน)'
  }),
  'pdpa.retention.closed_account_days': def(z.number().int().min(30), 90, {
    label: 'ลบบัญชีที่ปิดแล้ว (วัน) — แล้วทำให้ไม่ระบุตัวตน'
  }),

  'line.rich_menu_id': def(z.string().nullable(), null, { label: 'LINE Rich Menu ID' }),
  'features.line_login': def(z.boolean(), false, {
    exposed: true,
    label: 'เปิดใช้งานเข้าสู่ระบบด้วย LINE'
  })
} as const satisfies Record<string, SettingDef<unknown>>

export type SettingKey = keyof typeof REGISTRY
export type SettingValue<K extends SettingKey> = (typeof REGISTRY)[K]['default']

export const settingKeys = Object.keys(REGISTRY) as SettingKey[]
export const isSettingKey = (k: string): k is SettingKey => k in REGISTRY
