import { eq } from 'drizzle-orm'
import type { Db } from '../../db/client.js'
import { customers } from '../../db/schema/index.js'
import type { AuthProvider, AuthResult } from '../auth/provider.js'
import { customerRealm } from '../auth/realms.js'
import { now } from '../time.js'
import { verifyLineIdToken } from './id-token.js'

export interface LineLoginInput {
  idToken: string
  nonce?: string | null
}

/**
 * Decision #7's payoff: LINE is a second `AuthProvider`, not a second account
 * table. The token proves who the LINE user is; the `line_user_id` column
 * says which existing customer that is. If nobody claims it, the answer is
 * "link first" — never "create an account", because an account with no phone
 * number cannot be reached by staff and cannot receive a password reset.
 */
export function createLineIdTokenProvider(): AuthProvider {
  return {
    kind: 'line',

    async authenticate(db: Db, raw): Promise<AuthResult> {
      const input = raw as LineLoginInput
      const identity = await verifyLineIdToken(input.idToken, { nonce: input.nonce })

      const row = db
        .select()
        .from(customers)
        .where(eq(customers.lineUserId, identity.sub))
        .get()
      if (!row) return { ok: false, reason: 'not_linked' }
      if (row.isBlocked) return { ok: false, reason: 'blocked' }

      const at = now()
      // The display name and avatar change on LINE's side, not ours; refresh
      // them on every login so the profile screen is never stale.
      db.update(customers)
        .set({ lineDisplayName: identity.name, linePictureUrl: identity.picture })
        .where(eq(customers.id, row.id))
        .run()
      customerRealm.recordSuccess(db, row.id, at)

      const user = customerRealm.getById(db, row.id)!
      return { ok: true, userId: row.id, user }
    }
  }
}

export const lineIdTokenProvider = createLineIdTokenProvider()
