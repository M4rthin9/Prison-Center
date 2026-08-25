import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, asc, count, eq, isNull, like, or, sql } from 'drizzle-orm'
import { Category, PageQuery, Product, ShopDetail, ShopSummary, Ulid, pageOf } from '@pc/contract'
import { db } from '../../db/client.js'
import { categories, products, shops } from '../../db/schema/index.js'
import { notFound } from '../../lib/errors.js'
import { decodeCursor, paginate } from '../../lib/cursor.js'
import { commonErrors, jsonRes } from '../../lib/openapi.js'
import { defaultHook } from '../../lib/hook.js'
import type { AppEnv } from '../../types.js'
import { decorateProducts, decorateShops } from './service.js'

export function createCatalogRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })

  /* ── shops ─────────────────────────────────────────────────────────── */

  app.openapi(
    createRoute({
      method: 'get',
      path: '/shops',
      tags: ['catalog'],
      summary: 'ร้านค้าที่เปิดให้บริการ',
      description: 'กรองตามเรือนจำและแดน — ร้านที่ zoneId เป็น null ให้บริการทุกแดน',
      request: { query: z.object({ prisonId: Ulid.optional(), zoneId: Ulid.optional() }) },
      responses: {
        200: jsonRes(z.object({ items: z.array(ShopSummary) }), 'รายชื่อร้านค้า'),
        ...commonErrors
      }
    }),
    (c) => {
      const { prisonId, zoneId } = c.req.valid('query')
      const rows = db()
        .select()
        .from(shops)
        .where(
          and(
            eq(shops.isActive, true),
            prisonId ? eq(shops.prisonId, prisonId) : undefined,
            // A shop with no zone serves the whole facility.
            zoneId ? or(isNull(shops.zoneId), eq(shops.zoneId, zoneId)) : undefined
          )
        )
        .orderBy(asc(shops.sortOrder), asc(shops.name))
        .all()

      const items = decorateShops(rows, db()).map(({ hours, hoursSource, ...view }) => view)
      return c.json({ items }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/shops/{id}',
      tags: ['catalog'],
      summary: 'ข้อมูลร้านค้าและเวลาทำการ',
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(ShopDetail, 'ข้อมูลร้านค้า'), ...commonErrors }
    }),
    (c) => {
      const row = db()
        .select()
        .from(shops)
        .where(eq(shops.id, c.req.valid('param').id))
        .get()
      if (!row || !row.isActive) throw notFound('ไม่พบร้านค้า')
      return c.json(decorateShops([row], db())[0]!, 200)
    }
  )

  /* ── categories ────────────────────────────────────────────────────── */

  app.openapi(
    createRoute({
      method: 'get',
      path: '/categories',
      tags: ['catalog'],
      summary: 'หมวดหมู่สินค้า',
      description: 'ระบุ shopId เพื่อดูเฉพาะหมวดหมู่ที่ร้านนั้นมีสินค้าอยู่จริง',
      request: { query: z.object({ shopId: Ulid.optional() }) },
      responses: {
        200: jsonRes(z.object({ items: z.array(Category) }), 'หมวดหมู่'),
        ...commonErrors
      }
    }),
    (c) => {
      const { shopId } = c.req.valid('query')

      if (!shopId) {
        const items = db()
          .select({
            id: categories.id,
            name: categories.name,
            sortOrder: categories.sortOrder,
            isActive: categories.isActive
          })
          .from(categories)
          .where(eq(categories.isActive, true))
          .orderBy(asc(categories.sortOrder), asc(categories.name))
          .all()
        return c.json({ items }, 200)
      }

      // Counted with a join + groupBy, never a correlated subquery: drizzle
      // renders bare column names inside `sql` templates and would resolve both
      // sides of the correlation inside the subquery.
      const items = db()
        .select({
          id: categories.id,
          name: categories.name,
          sortOrder: categories.sortOrder,
          isActive: categories.isActive,
          productCount: count(products.id)
        })
        .from(categories)
        .innerJoin(
          products,
          and(
            eq(products.categoryId, categories.id),
            eq(products.shopId, shopId),
            eq(products.isActive, true)
          )
        )
        .where(eq(categories.isActive, true))
        .groupBy(categories.id)
        .orderBy(asc(categories.sortOrder), asc(categories.name))
        .all()

      return c.json({ items }, 200)
    }
  )

  /* ── products ──────────────────────────────────────────────────────── */

  app.openapi(
    createRoute({
      method: 'get',
      path: '/products',
      tags: ['catalog'],
      summary: 'สินค้าในร้าน',
      request: {
        query: PageQuery.extend({
          shopId: Ulid,
          categoryId: Ulid.optional(),
          q: z.string().max(80).optional()
        })
      },
      responses: { 200: jsonRes(pageOf(Product), 'รายการสินค้า'), ...commonErrors }
    }),
    (c) => {
      const { shopId, categoryId, q, cursor, limit } = c.req.valid('query')

      const shop = db().select().from(shops).where(eq(shops.id, shopId)).get()
      if (!shop || !shop.isActive) throw notFound('ไม่พบร้านค้า')

      const after = decodeCursor(cursor)
      const rows = db()
        .select()
        .from(products)
        .where(
          and(
            eq(products.shopId, shopId),
            eq(products.isActive, true),
            categoryId ? eq(products.categoryId, categoryId) : undefined,
            q ? like(products.name, `%${q}%`) : undefined,
            // Keyset on (name, id): a page boundary stays put even when the
            // catalog is edited between requests.
            after ? sql`(${products.name}, ${products.id}) > (${after[0]}, ${after[1]})` : undefined
          )
        )
        .orderBy(asc(products.name), asc(products.id))
        .limit(limit + 1)
        .all()

      const page = paginate(rows, limit, (r) => [r.name, r.id])
      return c.json({ items: decorateProducts(page.items, db()), nextCursor: page.nextCursor }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'get',
      path: '/products/{id}',
      tags: ['catalog'],
      summary: 'รายละเอียดสินค้า',
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(Product, 'สินค้า'), ...commonErrors }
    }),
    (c) => {
      const row = db()
        .select()
        .from(products)
        .where(eq(products.id, c.req.valid('param').id))
        .get()
      if (!row || !row.isActive) throw notFound('ไม่พบสินค้า')
      return c.json(decorateProducts([row], db())[0]!, 200)
    }
  )

  return app
}
