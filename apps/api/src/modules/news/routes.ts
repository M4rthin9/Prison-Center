import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, sql } from 'drizzle-orm'
import { NewsDetail, NewsSummary, PageQuery, Ulid, pageOf } from '@pc/contract'
import { db } from '../../db/client.js'
import { news } from '../../db/schema/index.js'
import { decodeCursor, paginate } from '../../lib/cursor.js'
import { commonErrors, jsonRes } from '../../lib/openapi.js'
import { defaultHook } from '../../lib/hook.js'
import type { AppEnv } from '../../types.js'
import { feedOrder, newsQuery, publicFilter, publishedBySlug, toSummary } from './service.js'

/**
 * The news feed is public: p.13 puts ข่าวสาร on the menu next to เกี่ยวกับเรา,
 * and a relative deciding whether to register should be able to read the
 * facility's announcements first.
 */
export function createNewsRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })

  app.openapi(
    createRoute({
      method: 'get',
      path: '/',
      tags: ['news'],
      summary: 'ข่าวสารที่เผยแพร่แล้ว',
      description: 'ข่าวที่ไม่ระบุเรือนจำคือประกาศส่วนกลาง แสดงในทุกเรือนจำเสมอ',
      request: { query: PageQuery.extend({ prisonId: Ulid.optional() }) },
      responses: { 200: jsonRes(pageOf(NewsSummary), 'รายการข่าว'), ...commonErrors }
    }),
    (c) => {
      const { cursor, limit, prisonId } = c.req.valid('query')
      const after = decodeCursor(cursor)

      const rows = newsQuery(db())
        .where(
          and(
            publicFilter(prisonId ?? null),
            // Same tuple as the ORDER BY, so a pinned notice added mid-scroll
            // cannot make the reader skip a page.
            after
              ? sql`(${news.isPinned}, ${news.publishedAt}, ${news.id}) < (${after[0]}, ${after[1]}, ${after[2]})`
              : undefined
          )
        )
        .orderBy(...feedOrder())
        .limit(limit + 1)
        .all()

      const page = paginate(rows, limit, (r) => [
        r.isPinned ? 1 : 0,
        r.publishedAt ?? 0,
        r.id
      ])
      return c.json({ items: page.items.map(toSummary), nextCursor: page.nextCursor }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/{slug}',
      tags: ['news'],
      summary: 'อ่านข่าว',
      description: '`bodyHtml` ถูกกรองแท็กตั้งแต่ตอนบันทึกแล้ว ฝั่งแอปแสดงผลได้โดยตรง',
      request: { params: z.object({ slug: z.string().min(1).max(120) }) },
      responses: { 200: jsonRes(NewsDetail, 'ข่าว'), ...commonErrors }
    }),
    (c) => c.json(publishedBySlug(c.req.valid('param').slug), 200)
  )

  return app
}
