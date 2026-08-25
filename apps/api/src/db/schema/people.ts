import { relations } from 'drizzle-orm'
import { index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { bool, id, timestamps, ts } from './_shared.js'
import { inmates, prisons } from './facility.js'

/* ── customers (ญาติผู้ต้องขัง) ─────────────────────────────────────────── */

export const customers = sqliteTable(
  'customers',
  {
    id: id(),
    /** Normalized Thai mobile, 0XXXXXXXXX. Doubles as the future OTP channel. */
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    fullName: text('full_name').notNull(),
    phone: text('phone').notNull(),
    /** The LINE ID a relative types in by hand (p.8) — display only, not identity. */
    lineIdText: text('line_id_text'),
    /** The verified `sub` from a LINE ID token. Nullable + unique from day one so
     *  Phase 7 linking is a single UPDATE, never a second account. */
    lineUserId: text('line_user_id'),

    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: ts('locked_until'),
    passwordChangedAt: ts('password_changed_at'),
    mustChangePassword: bool('must_change_password', false),
    isBlocked: bool('is_blocked', false),
    lastLoginAt: ts('last_login_at'),
    ...timestamps()
  },
  (t) => [
    uniqueIndex('uq_customers_username').on(t.username),
    uniqueIndex('uq_customers_line_user_id').on(t.lineUserId),
    index('idx_customers_name').on(t.fullName)
  ]
)

export const customerSessions = sqliteTable(
  'customer_sessions',
  {
    id: id(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    /** SHA-256 of the refresh token. The plaintext exists only in the cookie. */
    refreshTokenHash: text('refresh_token_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    revokedAt: ts('revoked_at'),
    /** Set when this row is rotated out; detects refresh-token replay. */
    replacedBy: text('replaced_by'),
    ...timestamps()
  },
  (t) => [
    uniqueIndex('uq_customer_sessions_token').on(t.refreshTokenHash),
    index('idx_customer_sessions_customer').on(t.customerId, t.expiresAt)
  ]
)

export type VerifyStatus = 'pending' | 'verified' | 'rejected'

/** The gate for everything sensitive: money, letters, visits. */
export const customerInmates = sqliteTable(
  'customer_inmates',
  {
    id: id(),
    customerId: text('customer_id')
      .notNull()
      .references(() => customers.id, { onDelete: 'cascade' }),
    inmateId: text('inmate_id')
      .notNull()
      .references(() => inmates.id, { onDelete: 'restrict' }),
    relationship: text('relationship'),
    verifyStatus: text('verify_status').$type<VerifyStatus>().notNull().default('pending'),
    verifiedAt: ts('verified_at'),
    verifiedBy: text('verified_by'),
    rejectReason: text('reject_reason'),
    ...timestamps()
  },
  (t) => [
    uniqueIndex('uq_customer_inmates').on(t.customerId, t.inmateId),
    index('idx_customer_inmates_inmate').on(t.inmateId, t.verifyStatus)
  ]
)

/* ── staff ─────────────────────────────────────────────────────────────── */

export type StaffRole =
  'super_admin' | 'prison_admin' | 'zone_staff' | 'finance' | 'letter_operator'

export const staff = sqliteTable(
  'staff',
  {
    id: id(),
    /** Assigned, never chosen. */
    username: text('username').notNull(),
    passwordHash: text('password_hash').notNull(),
    fullName: text('full_name').notNull(),
    email: text('email'),
    role: text('role').$type<StaffRole>().notNull(),
    /** NULL only for super_admin — department-wide scope. */
    prisonId: text('prison_id').references(() => prisons.id, { onDelete: 'restrict' }),

    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: ts('locked_until'),
    passwordChangedAt: ts('password_changed_at'),
    mustChangePassword: bool('must_change_password', true),
    isActive: bool('is_active', true),
    lastLoginAt: ts('last_login_at'),
    ...timestamps()
  },
  (t) => [
    uniqueIndex('uq_staff_username').on(t.username),
    index('idx_staff_prison').on(t.prisonId, t.role)
  ]
)

export const staffSessions = sqliteTable(
  'staff_sessions',
  {
    id: id(),
    staffId: text('staff_id')
      .notNull()
      .references(() => staff.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: ts('expires_at').notNull(),
    ip: text('ip'),
    userAgent: text('user_agent'),
    revokedAt: ts('revoked_at'),
    replacedBy: text('replaced_by'),
    ...timestamps()
  },
  (t) => [
    uniqueIndex('uq_staff_sessions_token').on(t.tokenHash),
    index('idx_staff_sessions_staff').on(t.staffId, t.expiresAt)
  ]
)

/* ── relations ─────────────────────────────────────────────────────────── */

export const customersRelations = relations(customers, ({ many }) => ({
  sessions: many(customerSessions),
  inmates: many(customerInmates)
}))

export const customerInmatesRelations = relations(customerInmates, ({ one }) => ({
  customer: one(customers, { fields: [customerInmates.customerId], references: [customers.id] }),
  inmate: one(inmates, { fields: [customerInmates.inmateId], references: [inmates.id] })
}))

export const staffRelations = relations(staff, ({ one, many }) => ({
  prison: one(prisons, { fields: [staff.prisonId], references: [prisons.id] }),
  sessions: many(staffSessions)
}))
