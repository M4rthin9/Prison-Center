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

/* ─── LINE (Phase 7) ─────────────────────────────────────────────────────── */

/**
 * The ID token comes from `liff.getIDToken()`. It is verified server-side
 * against LINE's keys — the client is never trusted for the `sub`.
 */
export const LineTokenInput = z.object({
  idToken: z.string().min(20).max(4096),
  /** Echoed back from `liff.init`; proves the token was minted for this login. */
  nonce: z.string().max(200).nullish()
})
export type LineTokenInput = z.infer<typeof LineTokenInput>

export const LineLinkState = z.object({
  lineLinked: z.boolean(),
  lineDisplayName: z.string().nullable(),
  linePictureUrl: z.string().nullable(),
  lineLinkedAt: z.number().int().nullable()
})
export type LineLinkState = z.infer<typeof LineLinkState>

/* ─── self-service password reset (Phase 7) ──────────────────────────────── */

export const PasswordResetRequestInput = z.object({ phone: ThaiPhone })
export type PasswordResetRequestInput = z.input<typeof PasswordResetRequestInput>

/**
 * Identical whether or not the number belongs to an account — this endpoint is
 * not a membership oracle.
 */
export const PasswordResetChallenge = z.object({
  reference: z.string(),
  channel: z.enum(['sms', 'line', 'console']),
  expiresIn: z.number().int(),
  /** Dev only (OTP_ECHO); never present in production. */
  code: z.string().optional()
})
export type PasswordResetChallenge = z.infer<typeof PasswordResetChallenge>

export const PasswordResetVerifyInput = z.object({
  reference: z.string().trim().min(4).max(16),
  code: z.string().trim().regex(/^\d{6}$/, 'รหัสยืนยันต้องเป็นตัวเลข 6 หลัก'),
  password: Password
})
export type PasswordResetVerifyInput = z.infer<typeof PasswordResetVerifyInput>

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
  lineDisplayName: z.string().nullable(),
  linePictureUrl: z.string().nullable(),
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
