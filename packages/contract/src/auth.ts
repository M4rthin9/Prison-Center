import { z } from 'zod'
import { Password, ThaiPhone, Ulid } from './common.js'

/* ─── customer realm ─────────────────────────────────────────────────────── */

export const RegisterInput = z.object({
  phone: ThaiPhone,
  password: Password,
  fullName: z.string().trim().min(2).max(120)
})
export type RegisterInput = z.input<typeof RegisterInput>

export const LoginInput = z.object({
  /** Phone for customers, assigned username for staff. */
  username: z.string().trim().min(3).max(60),
  password: z.string().min(1).max(200)
})
export type LoginInput = z.infer<typeof LoginInput>

export const ChangePasswordInput = z.object({
  current: z.string().min(1).max(200),
  next: Password
})
export type ChangePasswordInput = z.infer<typeof ChangePasswordInput>

/**
 * Both realms return this exact shape, from both password and (Phase 7) LINE
 * providers. The refresh token is NOT in the body — it is an httpOnly cookie.
 */
export const SessionResponse = z.object({
  accessToken: z.string(),
  expiresIn: z.number().int(),
  mustChangePassword: z.boolean()
})
export type SessionResponse = z.infer<typeof SessionResponse>

export const VerifyStatus = z.enum(['pending', 'verified', 'rejected'])
export type VerifyStatus = z.infer<typeof VerifyStatus>

export const LinkedInmate = z.object({
  id: Ulid,
  inmateId: Ulid,
  inmateCode: z.string(),
  fullName: z.string(),
  prisonId: Ulid,
  prisonName: z.string(),
  zoneId: Ulid.nullable(),
  zoneName: z.string().nullable(),
  relationship: z.string().nullable(),
  verifyStatus: VerifyStatus
})
export type LinkedInmate = z.infer<typeof LinkedInmate>

export const CreditBalance = z.object({
  direction: z.enum(['to_prison', 'to_home']),
  balance: z.number().int()
})

export const MeResponse = z.object({
  id: Ulid,
  username: z.string(),
  fullName: z.string(),
  phone: z.string(),
  lineIdText: z.string().nullable(),
  lineLinked: z.boolean(),
  mustChangePassword: z.boolean(),
  inmates: z.array(LinkedInmate),
  credits: z.array(CreditBalance)
})
export type MeResponse = z.infer<typeof MeResponse>

export const UpdateMeInput = z.object({
  fullName: z.string().trim().min(2).max(120).optional(),
  phone: ThaiPhone.optional(),
  lineIdText: z.string().trim().max(60).nullable().optional()
})
export type UpdateMeInput = z.input<typeof UpdateMeInput>

export const LinkInmateInput = z.object({
  inmateId: Ulid,
  relationship: z.string().trim().min(1).max(60)
})
export type LinkInmateInput = z.infer<typeof LinkInmateInput>

/* ─── staff realm ────────────────────────────────────────────────────────── */

export const StaffRole = z.enum([
  'super_admin',
  'prison_admin',
  'zone_staff',
  'finance',
  'letter_operator'
])
export type StaffRole = z.infer<typeof StaffRole>

export const AdminMeResponse = z.object({
  id: Ulid,
  username: z.string(),
  fullName: z.string(),
  email: z.string().nullable(),
  role: StaffRole,
  /** null == department-wide (super_admin only). */
  prisonId: Ulid.nullable(),
  prisonName: z.string().nullable(),
  mustChangePassword: z.boolean()
})
export type AdminMeResponse = z.infer<typeof AdminMeResponse>
