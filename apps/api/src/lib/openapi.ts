import type { z } from 'zod'
import { ApiError } from '@pc/contract'

export const jsonBody = <T extends z.ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
  required: true as const
})

export const jsonRes = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } }
})

const err = (description: string) => ({
  description,
  content: { 'application/json': { schema: ApiError } }
})

/** Attach to every route so the generated spec documents the error envelope. */
export const commonErrors = {
  400: err('คำขอไม่ถูกต้อง'),
  401: err('ต้องเข้าสู่ระบบ'),
  403: err('ไม่มีสิทธิ์'),
  404: err('ไม่พบข้อมูล'),
  409: err('ข้อมูลซ้ำ'),
  422: err('ข้อมูลไม่ผ่านการตรวจสอบ'),
  423: err('บัญชีถูกล็อก'),
  429: err('เรียกใช้บ่อยเกินไป')
}

export const bearerAuth = [{ bearerAuth: [] }]
