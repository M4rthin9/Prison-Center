import type { StaffRole } from './db/schema/index.js'

export interface CustomerPrincipal {
  kind: 'customer'
  id: string
  sessionId: string
  mustChangePassword: boolean
}

export interface StaffPrincipal {
  kind: 'staff'
  id: string
  sessionId: string
  role: StaffRole
  /** null == department-wide (super_admin only). */
  prisonId: string | null
  mustChangePassword: boolean
}

export type Principal = CustomerPrincipal | StaffPrincipal

export interface AppEnv {
  Variables: {
    requestId: string
    customer?: CustomerPrincipal
    staff?: StaffPrincipal
  }
}
