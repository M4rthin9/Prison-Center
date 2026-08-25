import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import { and, asc, eq, like, sql } from 'drizzle-orm'
import {
  Category,
  CreateCategoryInput,
  CreateProductInput,
  CreateShopInput,
  PageQuery,
  Product,
  ShopDetail,
  ShopHoursInput,
  ShopSummary,
  Ulid,
  UpdateCategoryInput,
  UpdateProductInput,
  UpdateShopInput,
  pageOf
} from '@pc/contract'
import { db } from '../../db/client.js'
import { categories, products, shopHours, shops, zones } from '../../db/schema/index.js'
import { writeAudit } from '../../lib/audit.js'
import { badRequest, conflict, notFound } from '../../lib/errors.js'
import { decodeCursor, paginate } from '../../lib/cursor.js'
import { bearerAuth, commonErrors, jsonBody, jsonRes } from '../../lib/openapi.js'
import { defaultHook } from '../../lib/hook.js'
import { requestContext } from '../../lib/auth/session.js'
import { blockUntilPasswordChanged, requireRole, requireStaff } from '../../middleware/auth.js'
import {
  assertInScope,
  prisonScope,
  resolvePrisonId,
  scopeFilter
} from '../../middleware/prison-scope.js'
import type { AppEnv } from '../../types.js'
import { decorateProducts, decorateShops } from './service.js'

/** Catalog is master data: only these two roles may write it. */
const canEditCatalog = requireRole('super_admin', 'prison_admin')
const Flag = z.enum(['true', 'false']).optional()

export function createAdminCatalogRoutes() {
  const app = new OpenAPIHono<AppEnv>({ defaultHook })
  app.use('*', requireStaff)
  app.use('*', blockUntilPasswordChanged)

  const shopDetail = (id: string) => {
    const row = db().select().from(shops).where(eq(shops.id, id)).get()
    if (!row) throw notFound('ไม่พบร้านค้า')
    return { row, view: decorateShops([row], db())[0]! }
  }

  /* ── shops ─────────────────────────────────────────────────────────── */

  app.openapi(
    createRoute({
      method: 'get',
      path: '/shops',
      tags: ['admin:catalog'],
      summary: 'ร้านค้าในขอบเขตของผู้ใช้',
      security: bearerAuth,
      request: { query: z.object({ prisonId: Ulid.optional(), includeInactive: Flag }) },
      responses: {
        200: jsonRes(z.object({ items: z.array(ShopSummary) }), 'รายชื่อร้านค้า'),
        ...commonErrors
      }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const { prisonId, includeInactive } = c.req.valid('query')
      const requested = resolvePrisonId(scope, prisonId ?? null)

      const rows = db()
        .select()
        .from(shops)
        .where(
          and(
            requested ? eq(shops.prisonId, requested) : scopeFilter(scope, shops.prisonId),
            includeInactive === 'true' ? undefined : eq(shops.isActive, true)
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
      tags: ['admin:catalog'],
      summary: 'ร้านค้าและเวลาทำการ',
      security: bearerAuth,
      request: { params: z.object({ id: Ulid }) },
      responses: { 200: jsonRes(ShopDetail, 'ร้านค้า'), ...commonErrors }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const { row, view } = shopDetail(c.req.valid('param').id)
      assertInScope(scope, row.prisonId)
      return c.json(view, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/shops',
      tags: ['admin:catalog'],
      summary: 'เพิ่มร้านค้า',
      security: bearerAuth,
      middleware: [canEditCatalog] as const,
      request: { body: jsonBody(CreateShopInput) },
      responses: { 201: jsonRes(ShopDetail, 'ร้านค้าที่สร้างแล้ว'), ...commonErrors }
    }),
    (c) => {
      const staff = c.get('staff')!
      const scope = prisonScope(staff)
      const input = c.req.valid('json')

      const prisonId = resolvePrisonId(scope, input.prisonId ?? null)
      if (!prisonId) throw badRequest('ต้องระบุเรือนจำ')

      if (input.zoneId) {
        const zone = db().select().from(zones).where(eq(zones.id, input.zoneId)).get()
        if (!zone || zone.prisonId !== prisonId)
          throw badRequest('แดนนี้ไม่ได้อยู่ในเรือนจำที่เลือก')
      }

      const duplicate = db()
        .select({ id: shops.id })
        .from(shops)
        .where(and(eq(shops.prisonId, prisonId), eq(shops.name, input.name)))
        .get()
      if (duplicate) throw conflict('มีร้านค้าชื่อนี้ในเรือนจำนี้แล้ว')

      const row = db()
        .insert(shops)
        .values({
          prisonId,
          zoneId: input.zoneId ?? null,
          name: input.name,
          shopType: input.shopType,
          description: input.description ?? null,
          sortOrder: input.sortOrder ?? 0,
          isActive: input.isActive ?? true,
          createdBy: staff.id,
          updatedBy: staff.id
        })
        .returning()
        .get()

      const ctx = requestContext(c)
      writeAudit({
        actorType: 'staff',
        actorId: staff.id,
        action: 'shop.created',
        entity: 'shop',
        entityId: row.id,
        prisonId,
        after: row,
        ip: ctx.ip,
        userAgent: ctx.userAgent
      })
      return c.json(decorateShops([row], db())[0]!, 201)
    }
  )

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/shops/{id}',
      tags: ['admin:catalog'],
      summary: 'แก้ไขร้านค้า',
      security: bearerAuth,
      middleware: [canEditCatalog] as const,
      request: { params: z.object({ id: Ulid }), body: jsonBody(UpdateShopInput) },
      responses: { 200: jsonRes(ShopDetail, 'ร้านค้าที่แก้ไขแล้ว'), ...commonErrors }
    }),
    (c) => {
      const staff = c.get('staff')!
      const scope = prisonScope(staff)
      const { id } = c.req.valid('param')
      const input = c.req.valid('json')
      const { row: before } = shopDetail(id)
      assertInScope(scope, before.prisonId)

      if (input.zoneId) {
        const zone = db().select().from(zones).where(eq(zones.id, input.zoneId)).get()
        if (!zone || zone.prisonId !== before.prisonId) {
          throw badRequest('แดนนี้ไม่ได้อยู่ในเรือนจำของร้านค้า')
        }
      }

      db()
        .update(shops)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.zoneId !== undefined ? { zoneId: input.zoneId } : {}),
          ...(input.shopType !== undefined ? { shopType: input.shopType } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          updatedBy: staff.id
        })
        .where(eq(shops.id, id))
        .run()

      const { view } = shopDetail(id)
      const ctx = requestContext(c)
      writeAudit({
        actorType: 'staff',
        actorId: staff.id,
        action: 'shop.updated',
        entity: 'shop',
        entityId: id,
        prisonId: before.prisonId,
        before,
        after: input,
        ip: ctx.ip,
        userAgent: ctx.userAgent
      })
      return c.json(view, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'put',
      path: '/shops/{id}/hours',
      tags: ['admin:catalog'],
      summary: 'ตั้งเวลาทำการของร้าน',
      description: 'เขียนครบทั้ง 7 วัน — ร้านที่ไม่มีแถวเวลาทำการจะใช้ค่าของเรือนจำแทน',
      security: bearerAuth,
      middleware: [canEditCatalog] as const,
      request: { params: z.object({ id: Ulid }), body: jsonBody(ShopHoursInput) },
      responses: { 200: jsonRes(ShopDetail, 'ร้านค้าพร้อมเวลาทำการ'), ...commonErrors }
    }),
    (c) => {
      const staff = c.get('staff')!
      const scope = prisonScope(staff)
      const { id } = c.req.valid('param')
      const { hours } = c.req.valid('json')
      const { row } = shopDetail(id)
      assertInScope(scope, row.prisonId)

      for (const h of hours) {
        if (h.isOpen && h.closesAt <= h.opensAt) {
          throw badRequest('เวลาปิดต้องอยู่หลังเวลาเปิด')
        }
      }

      db().transaction((tx) => {
        tx.delete(shopHours).where(eq(shopHours.shopId, id)).run()
        for (const h of hours) {
          tx.insert(shopHours)
            .values({
              shopId: id,
              weekday: h.weekday,
              opensAt: h.opensAt,
              closesAt: h.closesAt,
              isOpen: h.isOpen
            })
            .run()
        }
      })

      const ctx = requestContext(c)
      writeAudit({
        actorType: 'staff',
        actorId: staff.id,
        action: 'shop.hours_updated',
        entity: 'shop',
        entityId: id,
        prisonId: row.prisonId,
        after: hours,
        ip: ctx.ip,
        userAgent: ctx.userAgent
      })
      return c.json(shopDetail(id).view, 200)
    }
  )

  /* ── categories (department-wide) ──────────────────────────────────── */

  app.openapi(
    createRoute({
      method: 'get',
      path: '/categories',
      tags: ['admin:catalog'],
      summary: 'หมวดหมู่สินค้าทั้งหมด',
      security: bearerAuth,
      responses: {
        200: jsonRes(z.object({ items: z.array(Category) }), 'หมวดหมู่'),
        ...commonErrors
      }
    }),
    (c) =>
      c.json(
        {
          items: db()
            .select({
              id: categories.id,
              name: categories.name,
              sortOrder: categories.sortOrder,
              isActive: categories.isActive
            })
            .from(categories)
            .orderBy(asc(categories.sortOrder), asc(categories.name))
            .all()
        },
        200
      )
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/categories',
      tags: ['admin:catalog'],
      summary: 'เพิ่มหมวดหมู่',
      description: 'หมวดหมู่ใช้ร่วมกันทุกเรือนจำ จึงแก้ไขได้เฉพาะผู้ดูแลระบบส่วนกลาง',
      security: bearerAuth,
      middleware: [requireRole('super_admin')] as const,
      request: { body: jsonBody(CreateCategoryInput) },
      responses: { 201: jsonRes(Category, 'หมวดหมู่ที่สร้างแล้ว'), ...commonErrors }
    }),
    (c) => {
      const staff = c.get('staff')!
      const input = c.req.valid('json')
      const exists = db().select().from(categories).where(eq(categories.name, input.name)).get()
      if (exists) throw conflict('มีหมวดหมู่ชื่อนี้แล้ว')

      const row = db()
        .insert(categories)
        .values({
          name: input.name,
          sortOrder: input.sortOrder ?? 0,
          isActive: input.isActive ?? true
        })
        .returning()
        .get()

      writeAudit({
        actorType: 'staff',
        actorId: staff.id,
        action: 'category.created',
        entity: 'category',
        entityId: row.id,
        after: row
      })
      return c.json(
        { id: row.id, name: row.name, sortOrder: row.sortOrder, isActive: row.isActive },
        201
      )
    }
  )

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/categories/{id}',
      tags: ['admin:catalog'],
      summary: 'แก้ไขหมวดหมู่',
      security: bearerAuth,
      middleware: [requireRole('super_admin')] as const,
      request: { params: z.object({ id: Ulid }), body: jsonBody(UpdateCategoryInput) },
      responses: { 200: jsonRes(Category, 'หมวดหมู่ที่แก้ไขแล้ว'), ...commonErrors }
    }),
    (c) => {
      const staff = c.get('staff')!
      const { id } = c.req.valid('param')
      const input = c.req.valid('json')
      const before = db().select().from(categories).where(eq(categories.id, id)).get()
      if (!before) throw notFound('ไม่พบหมวดหมู่')

      const row = db()
        .update(categories)
        .set({
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {})
        })
        .where(eq(categories.id, id))
        .returning()
        .get()

      writeAudit({
        actorType: 'staff',
        actorId: staff.id,
        action: 'category.updated',
        entity: 'category',
        entityId: id,
        before,
        after: input
      })
      return c.json(
        { id: row.id, name: row.name, sortOrder: row.sortOrder, isActive: row.isActive },
        200
      )
    }
  )

  /* ── products ──────────────────────────────────────────────────────── */

  const shopInScope = (shopId: string, scope: ReturnType<typeof prisonScope>) => {
    const shop = db().select().from(shops).where(eq(shops.id, shopId)).get()
    if (!shop) throw notFound('ไม่พบร้านค้า')
    assertInScope(scope, shop.prisonId)
    return shop
  }

  app.openapi(
    createRoute({
      method: 'get',
      path: '/products',
      tags: ['admin:catalog'],
      summary: 'สินค้าทั้งหมดในขอบเขตของผู้ใช้',
      security: bearerAuth,
      request: {
        query: PageQuery.extend({
          shopId: Ulid.optional(),
          categoryId: Ulid.optional(),
          q: z.string().max(80).optional(),
          includeInactive: Flag
        })
      },
      responses: { 200: jsonRes(pageOf(Product), 'รายการสินค้า'), ...commonErrors }
    }),
    (c) => {
      const scope = prisonScope(c.get('staff'))
      const { shopId, categoryId, q, includeInactive, cursor, limit } = c.req.valid('query')
      if (shopId) shopInScope(shopId, scope)
      const after = decodeCursor(cursor)

      const rows = db()
        .select({ product: products })
        .from(products)
        .innerJoin(shops, eq(products.shopId, shops.id))
        .where(
          and(
            scopeFilter(scope, shops.prisonId),
            shopId ? eq(products.shopId, shopId) : undefined,
            categoryId ? eq(products.categoryId, categoryId) : undefined,
            q ? like(products.name, `%${q}%`) : undefined,
            includeInactive === 'true' ? undefined : eq(products.isActive, true),
            after ? sql`(${products.name}, ${products.id}) > (${after[0]}, ${after[1]})` : undefined
          )
        )
        .orderBy(asc(products.name), asc(products.id))
        .limit(limit + 1)
        .all()
        .map((r) => r.product)

      const page = paginate(rows, limit, (r) => [r.name, r.id])
      return c.json({ items: decorateProducts(page.items, db()), nextCursor: page.nextCursor }, 200)
    }
  )

  app.openapi(
    createRoute({
      method: 'post',
      path: '/products',
      tags: ['admin:catalog'],
      summary: 'เพิ่มสินค้า',
      security: bearerAuth,
      middleware: [canEditCatalog] as const,
      request: { body: jsonBody(CreateProductInput) },
      responses: { 201: jsonRes(Product, 'สินค้าที่สร้างแล้ว'), ...commonErrors }
    }),
    (c) => {
      const staff = c.get('staff')!
      const scope = prisonScope(staff)
      const input = c.req.valid('json')
      const shop = shopInScope(input.shopId, scope)

      if (input.categoryId) {
        const category = db()
          .select()
          .from(categories)
          .where(eq(categories.id, input.categoryId))
          .get()
        if (!category) throw badRequest('ไม่พบหมวดหมู่ที่เลือก')
      }

      const duplicate = db()
        .select({ id: products.id })
        .from(products)
        .where(and(eq(products.shopId, input.shopId), eq(products.sku, input.sku)))
        .get()
      if (duplicate) throw conflict('มีรหัสสินค้านี้ในร้านนี้แล้ว')

      const row = db()
        .insert(products)
        .values({
          shopId: input.shopId,
          categoryId: input.categoryId ?? null,
          sku: input.sku,
          name: input.name,
          description: input.description ?? null,
          priceSatang: input.priceSatang,
          unit: input.unit,
          productType: input.productType,
          maxPerOrder: input.maxPerOrder ?? 0,
          isActive: input.isActive ?? true,
          createdBy: staff.id,
          updatedBy: staff.id
        })
        .returning()
        .get()

      const ctx = requestContext(c)
      writeAudit({
        actorType: 'staff',
        actorId: staff.id,
        action: 'product.created',
        entity: 'product',
        entityId: row.id,
        prisonId: shop.prisonId,
        after: row,
        ip: ctx.ip,
        userAgent: ctx.userAgent
      })
      return c.json(decorateProducts([row], db())[0]!, 201)
    }
  )

  app.openapi(
    createRoute({
      method: 'patch',
      path: '/products/{id}',
      tags: ['admin:catalog'],
      summary: 'แก้ไขสินค้า',
      description:
        'การแก้ราคาไม่กระทบคำสั่งซื้อเดิม เพราะรายการสั่งซื้อเก็บสำเนาชื่อ/ราคา/หน่วยไว้แล้ว',
      security: bearerAuth,
      middleware: [canEditCatalog] as const,
      request: { params: z.object({ id: Ulid }), body: jsonBody(UpdateProductInput) },
      responses: { 200: jsonRes(Product, 'สินค้าที่แก้ไขแล้ว'), ...commonErrors }
    }),
    (c) => {
      const staff = c.get('staff')!
      const scope = prisonScope(staff)
      const { id } = c.req.valid('param')
      const input = c.req.valid('json')

      const before = db().select().from(products).where(eq(products.id, id)).get()
      if (!before) throw notFound('ไม่พบสินค้า')
      const shop = shopInScope(before.shopId, scope)

      if (input.sku && input.sku !== before.sku) {
        const duplicate = db()
          .select({ id: products.id })
          .from(products)
          .where(and(eq(products.shopId, before.shopId), eq(products.sku, input.sku)))
          .get()
        if (duplicate) throw conflict('มีรหัสสินค้านี้ในร้านนี้แล้ว')
      }

      const row = db()
        .update(products)
        .set({
          ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
          ...(input.sku !== undefined ? { sku: input.sku } : {}),
          ...(input.name !== undefined ? { name: input.name } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.priceSatang !== undefined ? { priceSatang: input.priceSatang } : {}),
          ...(input.unit !== undefined ? { unit: input.unit } : {}),
          ...(input.productType !== undefined ? { productType: input.productType } : {}),
          ...(input.maxPerOrder !== undefined ? { maxPerOrder: input.maxPerOrder } : {}),
          ...(input.isActive !== undefined ? { isActive: input.isActive } : {}),
          updatedBy: staff.id
        })
        .where(eq(products.id, id))
        .returning()
        .get()

      const ctx = requestContext(c)
      writeAudit({
        actorType: 'staff',
        actorId: staff.id,
        action: 'product.updated',
        entity: 'product',
        entityId: id,
        prisonId: shop.prisonId,
        before,
        after: input,
        ip: ctx.ip,
        userAgent: ctx.userAgent
      })
      return c.json(decorateProducts([row], db())[0]!, 200)
    }
  )

  return app
}
