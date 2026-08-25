import { z } from 'zod'
import { Ulid } from './common.js'

export const PaymentStatus = z.enum([
  'unpaid',
  'awaiting_verify',
  'paid',
  'failed',
  'refunded',
  'expired'
])
export type PaymentStatus = z.infer<typeof PaymentStatus>

export const FulfillmentStatus = z.enum(['new', 'preparing', 'delivered', 'cancelled'])
export type FulfillmentStatus = z.infer<typeof FulfillmentStatus>

export const PAYMENT_STATUS_LABEL: Record<PaymentStatus, string> = {
  unpaid: 'ยังไม่ชำระ',
  awaiting_verify: 'รอตรวจสอบการชำระ',
  paid: 'ชำระแล้ว',
  failed: 'ชำระไม่สำเร็จ',
  refunded: 'คืนเงินแล้ว',
  expired: 'หมดอายุ'
}

export const FULFILLMENT_STATUS_LABEL: Record<FulfillmentStatus, string> = {
  new: 'คำสั่งซื้อใหม่',
  preparing: 'กำลังจัดเตรียม',
  delivered: 'ส่งมอบแล้ว',
  cancelled: 'ยกเลิก'
}

/**
 * The cart the client posts. Prices are absent on purpose: the server re-prices
 * every line from `products` and never trusts a client-supplied amount.
 */
export const CartItemInput = z.object({
  productId: Ulid,
  qty: z.number().int().min(1, 'จำนวนอย่างน้อย 1').max(99)
})
export type CartItemInput = z.infer<typeof CartItemInput>

export const CreateOrderInput = z.object({
  inmateId: Ulid,
  shopId: Ulid,
  items: z.array(CartItemInput).min(1, 'ต้องมีสินค้าอย่างน้อย 1 รายการ').max(50),
  note: z.string().max(500).nullable().optional()
})
export type CreateOrderInput = z.infer<typeof CreateOrderInput>

export const OrderItemView = z.object({
  id: Ulid,
  productId: Ulid.nullable(),
  sku: z.string(),
  name: z.string(),
  unit: z.string(),
  categoryName: z.string().nullable(),
  unitPriceSatang: z.number().int(),
  qty: z.number().int(),
  lineTotalSatang: z.number().int()
})
export type OrderItemView = z.infer<typeof OrderItemView>

export const OrderSummary = z.object({
  id: Ulid,
  orderNo: z.string(),
  shopId: Ulid,
  shopName: z.string().nullable(),
  prisonId: Ulid,
  prisonName: z.string().nullable(),
  inmateId: Ulid,
  /** Snapshotted at order time — a transfer must not rewrite history. */
  inmateCode: z.string(),
  inmateName: z.string(),
  zoneName: z.string().nullable(),
  itemCount: z.number().int(),
  totalSatang: z.number().int(),
  paymentStatus: PaymentStatus,
  fulfillmentStatus: FulfillmentStatus,
  orderedAt: z.number()
})
export type OrderSummary = z.infer<typeof OrderSummary>

export const OrderDetail = OrderSummary.extend({
  customerId: Ulid,
  customerName: z.string(),
  customerPhone: z.string(),
  subtotalSatang: z.number().int(),
  discountSatang: z.number().int(),
  note: z.string().nullable(),
  cancelReason: z.string().nullable(),
  paidAt: z.number().nullable(),
  fulfilledAt: z.number().nullable(),
  cancelledAt: z.number().nullable(),
  items: z.array(OrderItemView)
})
export type OrderDetail = z.infer<typeof OrderDetail>

export const UpdateFulfillmentInput = z.object({
  status: z.enum(['new', 'preparing', 'delivered', 'cancelled']),
  /** Required when cancelling — it is shown to the relative. */
  reason: z.string().max(300).optional()
})
export type UpdateFulfillmentInput = z.infer<typeof UpdateFulfillmentInput>
