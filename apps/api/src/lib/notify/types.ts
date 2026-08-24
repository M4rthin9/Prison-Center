/** Every notification the system can raise. Add the kind here first. */
export type NotificationKind =
  | 'account.password_reset'
  | 'account.link_verified'
  | 'order.paid'
  | 'order.ready'
  | 'payment.verified'
  | 'payment.rejected'
  | 'deposit.reviewed'
  | 'letter.printed'
  | 'visit.reminder'

export interface Notification {
  audience: 'customer' | 'staff'
  recipientId: string
  kind: NotificationKind
  title: string
  body: string
  data?: Record<string, unknown>
}

/**
 * LINE push needs `line_user_id`, which does not exist before Phase 7 — so the
 * adapter ships from Phase 0 with in-app and console implementations and the
 * call sites never change when push lands.
 */
export interface NotifierAdapter {
  readonly kind: 'console' | 'in_app' | 'line'
  send(n: Notification): Promise<void>
}
