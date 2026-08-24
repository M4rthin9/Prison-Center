import { createMiddleware } from 'hono/factory'
import { newId } from '../lib/ids.js'
import type { AppEnv } from '../types.js'

export const requestId = createMiddleware<AppEnv>(async (c, next) => {
  const id = c.req.header('x-request-id') ?? newId()
  c.set('requestId', id)
  c.header('x-request-id', id)
  await next()
})
