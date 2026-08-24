import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, asc, count, eq } from 'drizzle-orm'
import { PrisonDetail, PrisonSummary, Ulid } from '@pc/contract'
import { db } from '../../db/client.js'
import { prisons, zones } from '../../db/schema/index.js'
import { notFound } from '../../lib/errors.js'
import { commonErrors, jsonRes } from '../../lib/openapi.js'
import { defaultHook } from '../../lib/hook.js'
import type { AppEnv } from '../../types.js'

export function createPrisonRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['prisons'],
      summary: 'รายชื่อเรือนจำที่เปิดให้บริการ',
      responses: {
        200: jsonRes(z.object({ items: z.array(PrisonSummary) }), 'รายชื่อเรือนจำ'),
        ...commonErrors
      }
    }),
    (c) => {
      // Aggregate via a join, not a correlated subquery: drizzle renders bare
      // column names inside `sql` templates, which silently breaks correlation.
      const items = db()
        .select({
          id: prisons.id,
          code: prisons.code,
          nameTh: prisons.nameTh,
          nameEn: prisons.nameEn,
          province: prisons.province,
          zoneCount: count(zones.id)
        })
        .from(prisons)
        .leftJoin(zones, and(eq(zones.prisonId, prisons.id), eq(zones.isActive, true)))
        .where(eq(prisons.isActive, true))
        .groupBy(prisons.id)
        .orderBy(asc(prisons.nameTh))
        .all()
      return c.json({ items }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/{id}',
      tags: ['prisons'],
      summary: 'ข้อมูลเรือนจำและแดน',
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(PrisonDetail, 'ข้อมูลเรือนจำ'), ...commonErrors }
    }),
    (c) => {
      const { id } = c.req.valid('param')
      const row = db().select().from(prisons).where(eq(prisons.id, id)).get()
      if (!row || !row.isActive) throw notFound('ไม่พบเรือนจำ')

      const zoneRows = db()
        .select({
          id: zones.id,
          name: zones.name,
          code: zones.code,
          sortOrder: zones.sortOrder,
          isActive: zones.isActive
        })
        .from(zones)
        .where(eq(zones.prisonId, id))
        .orderBy(asc(zones.sortOrder), asc(zones.name))
        .all()

      return c.json(
        {
          id: row.id,
          code: row.code,
          nameTh: row.nameTh,
          nameEn: row.nameEn,
          province: row.province,
          address: row.address,
          phone: row.phone,
          zoneCount: zoneRows.filter((z) => z.isActive).length,
          zones: zoneRows
        },
        200
      )
    }
  )

  return app
}
