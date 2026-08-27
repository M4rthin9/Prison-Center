import { OpenAPIHono, createRoute } from '@hono/zod-openapi'
import {
  ChangePasswordInput,
  LineLinkState,
  LineTokenInput,
  LoginInput,
  PasswordResetChallenge,
  PasswordResetRequestInput,
  PasswordResetVerifyInput,
  RegisterInput,
  SessionResponse
} from '@pc/contract'
import type { AppEnv } from '../../types.js'
import { db } from '../../db/client.js'
import {
  clearRefreshCookie,
  readRefreshCookie,
  requestContext,
  rotateSession,
  revokeSessionByToken,
  setRefreshCookie,
  type AuthProvider,
  type IssuedSession,
  type RealmSpec
} from '../../lib/auth/index.js'
import { unauthorized } from '../../lib/errors.js'
import { bearerAuth, commonErrors, jsonBody, jsonRes } from '../../lib/openapi.js'
import { requireCustomer, requireStaff } from '../../middleware/auth.js'
import { LINE_POLICY, LOGIN_POLICY, rateLimit } from '../../middleware/rate-limit.js'
import { changePassword, login, registerCustomer } from './service.js'
import { lineLogin, linkLineAccount, unlinkLineAccount } from './line.js'
import { completePasswordReset, requestPasswordReset } from './reset.js'
import { defaultHook } from '../../lib/hook.js'

const toBody = (s: IssuedSession) => ({
  accessToken: s.accessToken,
  expiresIn: s.expiresIn,
  mustChangePassword: s.mustChangePassword
})

/**
 * One factory, two mounts: `/api/v1/auth` and `/api/v1/admin/auth`. Both realms
 * expose exactly the same endpoints and the same response shape, which is what
 * lets the LINE provider drop in later without touching either app.
 */
export function createAuthRoutes(opts: {
  spec: RealmSpec
  provider: AuthProvider
  tag: string
  allowRegister: boolean
  /** LINE login/link and OTP reset are customer-realm only. */
  lineAndReset?: boolean
}) {
  const { spec, provider, tag } = opts
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  const guard = spec.realm === 'staff' ? requireStaff : requireCustomer

  if (opts.allowRegister) {
    app.use('/register', rateLimit('register', LOGIN_POLICY))
    app.openapi(
      createRoute({
        method: 'post',
        path: '/register',
        tags: [tag],
        summary: 'สมัครสมาชิก (ญาติผู้ต้องขัง)',
        description:
          'บัญชีที่สมัครใหม่ดูข้อมูลได้อย่างเดียว จนกว่าเจ้าหน้าที่จะยืนยันความสัมพันธ์กับผู้ต้องขัง',
        request: { body: jsonBody(RegisterInput) },
        responses: { 201: jsonRes(SessionResponse, 'สมัครสำเร็จ'), ...commonErrors }
      }),
      async (c) => {
        const input = c.req.valid('json')
        const session = await registerCustomer(input, requestContext(c))
        setRefreshCookie(c, spec, session.refreshToken)
        return c.json(toBody(session), 201)
      }
    )
  }

  app.openapi(
    createRoute({
      method: 'post',
      path: '/login',
      tags: [tag],
      summary: 'เข้าสู่ระบบ',
      request: { body: jsonBody(LoginInput) },
      responses: { 200: jsonRes(SessionResponse, 'เข้าสู่ระบบสำเร็จ'), ...commonErrors }
    }),
    async (c) => {
      const input = c.req.valid('json')
      const session = await login(spec, provider, input, requestContext(c))
      setRefreshCookie(c, spec, session.refreshToken)
      return c.json(toBody(session), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/refresh',
      tags: [tag],
      summary: 'ต่ออายุเซสชัน (rotating refresh token)',
      description: 'อ่าน refresh token จากคุกกี้ httpOnly แล้วออกโทเคนชุดใหม่เสมอ',
      responses: { 200: jsonRes(SessionResponse, 'ต่ออายุสำเร็จ'), ...commonErrors }
    }),
    async (c) => {
      const presented = readRefreshCookie(c, spec)
      if (!presented) throw unauthorized('ไม่พบเซสชัน')
      const session = await rotateSession(spec, db(), presented, requestContext(c))
      setRefreshCookie(c, spec, session.refreshToken)
      return c.json(toBody(session), 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/logout',
      tags: [tag],
      summary: 'ออกจากระบบ',
      responses: {
        204: { description: 'ออกจากระบบแล้ว' },
        ...commonErrors
      }
    }),
    async (c) => {
      revokeSessionByToken(spec, db(), readRefreshCookie(c, spec))
      clearRefreshCookie(c, spec)
      return c.body(null, 204)
    }
  )

  app.use('/change-password', guard)
  app.openapi(
    createRoute({
      method: 'post',
      path: '/change-password',
      tags: [tag],
      summary: 'เปลี่ยนรหัสผ่าน',
      description: 'บังคับใช้เมื่อ mustChangePassword = true — เซสชันอื่นทั้งหมดจะถูกยกเลิก',
      security: bearerAuth,
      request: { body: jsonBody(ChangePasswordInput) },
      responses: { 200: jsonRes(SessionResponse, 'เปลี่ยนรหัสผ่านแล้ว'), ...commonErrors }
    }),
    async (c) => {
      const principal = c.get('customer') ?? c.get('staff')
      if (!principal) throw unauthorized()
      const input = c.req.valid('json')
      const session = await changePassword(spec, principal.id, input, requestContext(c))
      setRefreshCookie(c, spec, session.refreshToken)
      return c.json(toBody(session), 200)
    }
  )

  if (opts.lineAndReset) {
    app.use('/line/*', rateLimit('line', LINE_POLICY))

    app.openapi(
      createRoute({
        method: 'post',
        path: '/line/login',
        tags: [tag],
        summary: 'เข้าสู่ระบบด้วย LINE',
        description:
          'ตรวจสอบ ID token กับกุญแจของ LINE แล้วออกเซสชันรูปแบบเดียวกับการเข้าสู่ระบบด้วยรหัสผ่าน ' +
          'หากบัญชี LINE ยังไม่ได้เชื่อมกับผู้ใช้ จะได้รับรหัส LINE_NOT_LINKED',
        request: { body: jsonBody(LineTokenInput) },
        responses: { 200: jsonRes(SessionResponse, 'เข้าสู่ระบบสำเร็จ'), ...commonErrors }
      }),
      async (c) => {
        const session = await lineLogin(c.req.valid('json'), requestContext(c))
        setRefreshCookie(c, spec, session.refreshToken)
        return c.json(toBody(session), 200)
      }
    )

    app.use('/line/link', guard)
    app.openapi(
      createRoute({
        method: 'post',
        path: '/line/link',
        tags: [tag],
        summary: 'เชื่อมบัญชี LINE กับบัญชีที่เข้าสู่ระบบอยู่',
        security: bearerAuth,
        request: { body: jsonBody(LineTokenInput) },
        responses: { 200: jsonRes(LineLinkState, 'เชื่อมบัญชีแล้ว'), ...commonErrors }
      }),
      async (c) => {
        const principal = c.get('customer')
        if (!principal) throw unauthorized()
        const state = await linkLineAccount(principal.id, c.req.valid('json'), requestContext(c))
        return c.json(state, 200)
      }
    )

    app.openapi(
      createRoute({
        method: 'delete',
        path: '/line/link',
        tags: [tag],
        summary: 'ยกเลิกการเชื่อมบัญชี LINE',
        description: 'บัญชียังใช้เบอร์มือถือและรหัสผ่านเข้าสู่ระบบได้ตามเดิม',
        security: bearerAuth,
        responses: { 200: jsonRes(LineLinkState, 'ยกเลิกการเชื่อมแล้ว'), ...commonErrors }
      }),
      async (c) => {
        const principal = c.get('customer')
        if (!principal) throw unauthorized()
        return c.json(unlinkLineAccount(principal.id, requestContext(c)), 200)
      }
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/password-reset/request',
        tags: [tag],
        summary: 'ขอรหัสยืนยันเพื่อตั้งรหัสผ่านใหม่',
        description:
          'คำตอบเหมือนกันทุกกรณี ไม่ว่าเบอร์นั้นจะมีบัญชีอยู่หรือไม่ — เพื่อไม่ให้ใช้ตรวจสอบว่าเบอร์ใดลงทะเบียนไว้',
        request: { body: jsonBody(PasswordResetRequestInput) },
        responses: { 200: jsonRes(PasswordResetChallenge, 'ส่งรหัสยืนยันแล้ว'), ...commonErrors }
      }),
      async (c) => c.json(await requestPasswordReset(c.req.valid('json'), requestContext(c)), 200)
    )

    app.openapi(
      createRoute({
        method: 'post',
        path: '/password-reset/verify',
        tags: [tag],
        summary: 'ยืนยันรหัสและตั้งรหัสผ่านใหม่',
        description: 'ทุกเซสชันเดิมของบัญชีนี้จะถูกยกเลิก แล้วให้เข้าสู่ระบบใหม่ด้วยรหัสผ่านที่ตั้ง',
        request: { body: jsonBody(PasswordResetVerifyInput) },
        responses: { 204: { description: 'ตั้งรหัสผ่านใหม่แล้ว' }, ...commonErrors }
      }),
      async (c) => {
        await completePasswordReset(c.req.valid('json'), requestContext(c))
        return c.body(null, 204)
      }
    )
  }

  return app
}
