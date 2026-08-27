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
    /** Profile fields copied from the verified ID token — display only. */
    lineDisplayName: text('line_display_name'),
    linePictureUrl: text('line_picture_url'),
    lineLinkedAt: ts('line_linked_at'),

    failedAttempts: integer('failed_attempts').notNull().default(0),
    lockedUntil: ts('locked_until'),
    passwordChangedAt: ts('password_changed_at'),
    mustChangePassword: bool('must_change_password', false),
    isBlocked: bool('is_blocked', false),
    lastLoginAt: ts('last_login_at'),
    /** Set when the relative asks for deletion; PDPA anonymizes it later. */
    closedAt: ts('closed_at'),
    /** Set by the retention job once the personal columns are scrubbed. The
     *  row stays so financial history keeps its foreign keys. */
    anonymizedAt: ts('anonymized_at'),
    ...timestamps()
  },
  (t) => [
    uniqueIndex('uq_customers_username').on(t.username),
    uniqueIndex('uq_customers_line_user_id').on(t.lineUserId),
    index('idx_customers_name').on(t.fullName),
    index('idx_customers_closed').on(t.closedAt)
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

export type OtpPurpose = 'password_reset'
export type OtpChannel = 'sms' | 'line' | 'console'

/**
 * Self-service password reset (§ Phase 7). The code itself is never stored —
 * only its SHA-256, exactly like a refresh token, so a database leak cannot be
 * replayed. `reference` is the four-character code the relative reads back to
 * staff on the phone; it also binds the verify call to the request that issued
 * it, so a code from one challenge cannot be spent on another.
 */
export const otpChallenges = sqliteTable(
  'otp_challenges',
  {
    id: id(),
    purpose: text('purpose').$type<OtpPurpose>().notNull(),
    /** Normalized Thai mobile — the identity being proven, not a foreign key. */
    target: text('target').notNull(),
    reference: text('reference').notNull(),
    codeHash: text('code_hash').notNull(),
    channel: text('channel').$type<OtpChannel>().notNull().default('console'),
    /** NULL when the phone matches no account — issued anyway so the response
     *  cannot be used to enumerate registered numbers. */
    customerId: text('customer_id').references(() => customers.id, { onDelete: 'cascade' }),
    attempts: integer('attempts').notNull().default(0),
    maxAttempts: integer('max_attempts').notNull().default(5),
    expiresAt: ts('expires_at').notNull(),
    consumedAt: ts('consumed_at'),
    ip: text('ip'),
    ...timestamps()
  },
  (t) => [
    uniqueIndex('uq_otp_reference').on(t.reference),
    index('idx_otp_target').on(t.target, t.purpose, t.expiresAt)
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
