import type { ReportKind } from '@pc/contract'

/**
 * §7 — one definition per report: the Thai column headers, how each column is
 * formatted in the sheet, and which SQL file produces it. The SQL lives in
 * `queries/*.sql` so it can be pasted straight into a sqlite shell when an
 * auditor disputes a total.
 */
export type ColumnFormat =
  /** satang integer → baht, `#,##0.00`. */
  | 'money'
  /** epoch ms → Bangkok `dd/mm/พ.ศ. HH:MM`. */
  | 'datetime'
  /** `YYYY-MM` / `YYYY` / literal → Thai month + Buddhist year. */
  | 'period'
  | 'int'
  | 'text'

export interface ReportColumn {
  key: string
  header: string
  width: number
  format?: ColumnFormat
}

export interface ReportDefinition {
  kind: ReportKind
  /** Row 1 of the sheet, and the download filename stem. */
  title: string
  sheet: string
  /** Extra line under the title when the grain needs explaining. */
  note?: string
  columns: ReportColumn[]
  /** Columns summed into the bold totals row at the bottom. */
  totals: string[]
}

const money = (key: string, header: string, width = 16): ReportColumn => ({
  key,
  header,
  width,
  format: 'money'
})
const int = (key: string, header: string, width = 10): ReportColumn => ({
  key,
  header,
  width,
  format: 'int'
})
const text = (key: string, header: string, width = 18): ReportColumn => ({
  key,
  header,
  width,
  format: 'text'
})

export const REPORTS: Record<ReportKind, ReportDefinition> = {
  sales: {
    kind: 'sales',
    title: 'รายงานการขาย',
    sheet: 'การขาย',
    columns: [
      { key: 'orderedAt', header: 'วันที่', width: 18, format: 'datetime' },
      text('orderNo', 'เลขคำสั่งซื้อ', 20),
      text('prisonName', 'เรือนจำ', 22),
      text('zoneName', 'แดน', 12),
      text('shopName', 'ร้านค้า', 22),
      text('inmateCode', 'รหัสผู้ต้องขัง', 16),
      text('inmateName', 'ผู้ต้องขัง', 22),
      text('customerName', 'ผู้สั่งซื้อ', 22),
      text('customerPhone', 'เบอร์โทร', 14),
      money('totalSatang', 'จำนวนเงิน'),
      text('paymentStatus', 'สถานะชำระ', 16),
      { key: 'paidAt', header: 'วันที่ชำระ', width: 18, format: 'datetime' },
      text('hasSlip', 'สลิป', 8),
      text('transRef', 'เลขอ้างอิงสลิป', 24)
    ],
    totals: ['totalSatang']
  },

  sales_detail: {
    kind: 'sales_detail',
    title: 'สรุปการขาย',
    sheet: 'รายการสินค้า',
    note: 'หนึ่งบรรทัดต่อหนึ่งรายการสินค้าในคำสั่งซื้อ',
    columns: [
      { key: 'orderedAt', header: 'วันที่', width: 18, format: 'datetime' },
      text('orderNo', 'เลขคำสั่งซื้อ', 20),
      text('prisonName', 'เรือนจำ', 22),
      text('sku', 'รหัสสินค้า', 14),
      text('productName', 'สินค้า', 28),
      text('categoryName', 'หมวดหมู่', 18),
      int('qty', 'จำนวน'),
      text('unit', 'หน่วย', 10),
      money('unitPriceSatang', 'ราคา'),
      money('lineTotalSatang', 'รวม'),
      text('senderName', 'ผู้ส่ง', 22),
      text('senderPhone', 'เบอร์โทร', 14),
      text('inmateName', 'ผู้รับ', 22),
      text('zoneName', 'แดน', 12),
      text('inmateCode', 'รหัส', 16),
      text('note', 'หมายเหตุ', 28)
    ],
    totals: ['qty', 'lineTotalSatang']
  },

  products: {
    kind: 'products',
    title: 'รายงานสินค้าที่มีการขาย',
    sheet: 'สินค้าที่ขายได้',
    note: 'นับเฉพาะคำสั่งซื้อที่ชำระเงินแล้ว · แดน = ค่าที่บันทึกไว้ตอนสั่งซื้อ · กองงาน = ค่าปัจจุบันของผู้ต้องขัง',
    columns: [
      { key: 'period', header: 'ช่วงเวลา', width: 16, format: 'period' },
      text('prisonName', 'เรือนจำ', 22),
      text('sku', 'รหัสสินค้า', 14),
      text('productName', 'สินค้า', 28),
      text('zoneName', 'แดน', 12),
      text('workDivision', 'กองงาน', 20),
      int('orderCount', 'จำนวนคำสั่งซื้อ', 16),
      int('qty', 'จำนวนที่ขาย', 14),
      money('totalSatang', 'ยอดขาย')
    ],
    totals: ['orderCount', 'qty', 'totalSatang']
  },

  visits: {
    kind: 'visits',
    title: 'รายงานการเยี่ยม',
    sheet: 'การเยี่ยม',
    note: 'นับตามวันที่เข้าเยี่ยม ไม่ใช่วันที่จอง',
    columns: [
      { key: 'period', header: 'ช่วงเวลา', width: 16, format: 'period' },
      text('prisonName', 'เรือนจำ', 22),
      text('zoneName', 'แดน', 12),
      text('roundLabel', 'รอบเยี่ยม', 20),
      int('bookingCount', 'รายการทั้งหมด', 16),
      int('bookedCount', 'ใช้สิทธิ์', 12),
      int('checkedInCount', 'เช็คอิน', 12),
      int('cancelledCount', 'ยกเลิก', 12),
      int('noShowCount', 'ไม่มาตามนัด', 14),
      int('visitorCount', 'จำนวนผู้เยี่ยม', 16)
    ],
    totals: [
      'bookingCount',
      'bookedCount',
      'checkedInCount',
      'cancelledCount',
      'noShowCount',
      'visitorCount'
    ]
  },

  letters: {
    kind: 'letters',
    title: 'รายงานจดหมายอิเล็กทรอนิกส์',
    sheet: 'จดหมาย',
    note: 'ไม่นับฉบับร่าง',
    columns: [
      { key: 'period', header: 'ช่วงเวลา', width: 16, format: 'period' },
      text('prisonName', 'เรือนจำ', 22),
      text('zoneName', 'แดน', 12),
      text('direction', 'ทิศทาง', 22),
      int('letterCount', 'จำนวนฉบับ', 14),
      int('awaitingPrintCount', 'รอพิมพ์', 12),
      int('printedCount', 'พิมพ์แล้ว', 12),
      int('dispatchedCount', 'ส่งออกแล้ว', 14),
      int('deliveredCount', 'ถึงผู้รับ', 12),
      int('rejectedCount', 'ตีกลับ', 12),
      int('attachmentCount', 'รูปแนบ', 12)
    ],
    totals: [
      'letterCount',
      'awaitingPrintCount',
      'printedCount',
      'dispatchedCount',
      'deliveredCount',
      'rejectedCount',
      'attachmentCount'
    ]
  },

  payments: {
    kind: 'payments',
    title: 'รายงานการชำระเงิน',
    sheet: 'การชำระเงิน',
    note: 'ยอดเงินคือ charge_satang — จำนวนที่เรียกเก็บจริงรวมค่าปรับเศษสตางค์',
    columns: [
      { key: 'period', header: 'ช่วงเวลา', width: 16, format: 'period' },
      text('prisonName', 'เรือนจำ', 22),
      text('channelName', 'ช่องทาง', 24),
      text('rail', 'ประเภท', 22),
      text('purpose', 'วัตถุประสงค์', 18),
      int('attemptCount', 'ครั้งที่ทำรายการ', 18),
      int('succeededCount', 'สำเร็จ', 12),
      int('failedCount', 'ไม่สำเร็จ', 12),
      int('refundedCount', 'คืนเงิน', 12),
      int('openCount', 'ค้างอยู่', 12),
      money('succeededSatang', 'ยอดสำเร็จ'),
      money('refundedSatang', 'ยอดคืนเงิน')
    ],
    totals: [
      'attemptCount',
      'succeededCount',
      'failedCount',
      'refundedCount',
      'openCount',
      'succeededSatang',
      'refundedSatang'
    ]
  },

  deposits: {
    kind: 'deposits',
    title: 'รายงานสรุปยอดการฝากเงิน',
    sheet: 'การฝากเงิน',
    columns: [
      { key: 'period', header: 'ช่วงเวลา', width: 16, format: 'period' },
      text('prisonName', 'เรือนจำ', 22),
      text('zoneName', 'แดน', 12),
      int('depositCount', 'จำนวนรายการ', 16),
      int('pendingCount', 'รอชำระ', 12),
      int('reviewingCount', 'รอโอนเข้าบัญชี', 18),
      int('completedCount', 'เสร็จสิ้น', 12),
      int('rejectedCount', 'ปฏิเสธ/ยกเลิก', 16),
      money('receivedSatang', 'ยอดที่รับแล้ว'),
      money('completedSatang', 'ยอดที่โอนเข้าบัญชี')
    ],
    totals: [
      'depositCount',
      'pendingCount',
      'reviewingCount',
      'completedCount',
      'rejectedCount',
      'receivedSatang',
      'completedSatang'
    ]
  }
}
