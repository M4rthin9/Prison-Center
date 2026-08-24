import { and, eq, isNull, lt, or } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import {
  customerSessions,
  customers,
  staff,
  staffSessions,
  type StaffRole
} from '../../db/schema/index.js'

export type Realm = 'customer' | 'staff'

/** The shape both realms' user rows are reduced to for auth purposes. */
export interface AuthUser {
  id: string
  username: string
  fullName: string
  passwordHash: string
  failedAttempts: number
  lockedUntil: number | null
  mustChangePassword: boolean
  disabled: boolean
  /** Staff only. */
  role?: StaffRole
  prisonId?: string | null
}

export interface SessionRow {
  id: string
  userId: string
  expiresAt: number
  revokedAt: number | null
  replacedBy: string | null
}

export interface RealmSpec {
  realm: Realm
  /** Distinct cookie name and path — the two realms never share a session. */
  cookieName: string
  cookiePath: string
  getByUsername(db: Db, username: string): AuthUser | undefined
  getById(db: Db, id: string): AuthUser | undefined
  recordFailure(db: Db, id: string, failedAttempts: number, lockedUntil: number | null): void
  recordSuccess(db: Db, id: string, at: number): void
  setPassword(db: Db, id: string, hash: string, mustChange: boolean, at: number): void
  createSession(
    db: Db,
    input: { userId: string; tokenHash: string; expiresAt: number; ip?: string | null; userAgent?: string | null }
  ): string
  findSessionByHash(db: Db, tokenHash: string): SessionRow | undefined
  revokeSession(db: Db, id: string, replacedBy: string | null, at: number): void
  revokeAllForUser(db: Db, userId: string, at: number): void
  purgeExpiredSessions(db: Db, at: number): void
}

export const customerRealm: RealmSpec = {
  realm: 'customer',
  cookieName: 'pc_rt',
  cookiePath: '/api/v1/auth',

  getByUsername(db, username) {
    const row = db.select().from(customers).where(eq(customers.username, username)).get()
    return row && toCustomer(row)
  },
  getById(db, id) {
    const row = db.select().from(customers).where(eq(customers.id, id)).get()
    return row && toCustomer(row)
  },
  recordFailure(db, id, failedAttempts, lockedUntil) {
    db.update(customers).set({ failedAttempts, lockedUntil }).where(eq(customers.id, id)).run()
  },
  recordSuccess(db, id, at) {
    db.update(customers)
      .set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: at })
      .where(eq(customers.id, id))
      .run()
  },
  setPassword(db, id, hash, mustChange, at) {
    db.update(customers)
      .set({
        passwordHash: hash,
        mustChangePassword: mustChange,
        passwordChangedAt: at,
        failedAttempts: 0,
        lockedUntil: null
      })
      .where(eq(customers.id, id))
      .run()
  },
  createSession(db, input) {
    const row = db
      .insert(customerSessions)
      .values({
        customerId: input.userId,
        refreshTokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null
      })
      .returning({ id: customerSessions.id })
      .get()
    return row.id
  },
  findSessionByHash(db, tokenHash) {
    const row = db
      .select()
      .from(customerSessions)
      .where(eq(customerSessions.refreshTokenHash, tokenHash))
      .get()
    return (
      row && {
        id: row.id,
        userId: row.customerId,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
        replacedBy: row.replacedBy
      }
    )
  },
  revokeSession(db, id, replacedBy, at) {
    db.update(customerSessions)
      .set({ revokedAt: at, replacedBy })
      .where(eq(customerSessions.id, id))
      .run()
  },
  revokeAllForUser(db, userId, at) {
    db.update(customerSessions)
      .set({ revokedAt: at })
      .where(and(eq(customerSessions.customerId, userId), isNull(customerSessions.revokedAt)))
      .run()
  },
  purgeExpiredSessions(db, at) {
    db.delete(customerSessions)
      .where(or(lt(customerSessions.expiresAt, at), lt(customerSessions.revokedAt, at - 7 * 86400000)))
      .run()
  }
}

export const staffRealm: RealmSpec = {
  realm: 'staff',
  cookieName: 'pc_art',
  cookiePath: '/api/v1/admin/auth',

  getByUsername(db, username) {
    const row = db.select().from(staff).where(eq(staff.username, username)).get()
    return row && toStaff(row)
  },
  getById(db, id) {
    const row = db.select().from(staff).where(eq(staff.id, id)).get()
    return row && toStaff(row)
  },
  recordFailure(db, id, failedAttempts, lockedUntil) {
    db.update(staff).set({ failedAttempts, lockedUntil }).where(eq(staff.id, id)).run()
  },
  recordSuccess(db, id, at) {
    db.update(staff)
      .set({ failedAttempts: 0, lockedUntil: null, lastLoginAt: at })
      .where(eq(staff.id, id))
      .run()
  },
  setPassword(db, id, hash, mustChange, at) {
    db.update(staff)
      .set({
        passwordHash: hash,
        mustChangePassword: mustChange,
        passwordChangedAt: at,
        failedAttempts: 0,
        lockedUntil: null
      })
      .where(eq(staff.id, id))
      .run()
  },
  createSession(db, input) {
    const row = db
      .insert(staffSessions)
      .values({
        staffId: input.userId,
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        ip: input.ip ?? null,
        userAgent: input.userAgent ?? null
      })
      .returning({ id: staffSessions.id })
      .get()
    return row.id
  },
  findSessionByHash(db, tokenHash) {
    const row = db.select().from(staffSessions).where(eq(staffSessions.tokenHash, tokenHash)).get()
    return (
      row && {
        id: row.id,
        userId: row.staffId,
        expiresAt: row.expiresAt,
        revokedAt: row.revokedAt,
        replacedBy: row.replacedBy
      }
    )
  },
  revokeSession(db, id, replacedBy, at) {
    db.update(staffSessions).set({ revokedAt: at, replacedBy }).where(eq(staffSessions.id, id)).run()
  },
  revokeAllForUser(db, userId, at) {
    db.update(staffSessions)
      .set({ revokedAt: at })
      .where(and(eq(staffSessions.staffId, userId), isNull(staffSessions.revokedAt)))
      .run()
  },
  purgeExpiredSessions(db, at) {
    db.delete(staffSessions)
      .where(or(lt(staffSessions.expiresAt, at), lt(staffSessions.revokedAt, at - 7 * 86400000)))
      .run()
  }
}

export const realmSpec = (realm: Realm): RealmSpec =>
  realm === 'staff' ? staffRealm : customerRealm

type CustomerRow = typeof customers.$inferSelect
type StaffRow = typeof staff.$inferSelect

const toCustomer = (r: CustomerRow): AuthUser => ({
  id: r.id,
  username: r.username,
  fullName: r.fullName,
  passwordHash: r.passwordHash,
  failedAttempts: r.failedAttempts,
  lockedUntil: r.lockedUntil,
  mustChangePassword: r.mustChangePassword,
  disabled: r.isBlocked
})

const toStaff = (r: StaffRow): AuthUser => ({
  id: r.id,
  username: r.username,
  fullName: r.fullName,
  passwordHash: r.passwordHash,
  failedAttempts: r.failedAttempts,
  lockedUntil: r.lockedUntil,
  mustChangePassword: r.mustChangePassword,
  disabled: !r.isActive,
  role: r.role,
  prisonId: r.prisonId
})
