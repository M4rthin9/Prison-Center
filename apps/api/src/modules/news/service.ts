import { and, desc, eq, isNull, lte, or } from 'drizzle-orm'
import type { CreateNewsInput, NewsDetail, NewsSummary, UpdateNewsInput } from '@pc/contract'
import { db as defaultDb, type Db } from '../../db/client.js'
import { news, prisons, staff } from '../../db/schema/index.js'
import { writeAudit } from '../../lib/audit.js'
import { badRequest, conflict, notFound } from '../../lib/errors.js'
import { normalizeImage } from '../../lib/image.js'
import { storage } from '../../lib/storage/index.js'
import { now } from '../../lib/time.js'
import { deriveExcerpt, sanitizeNewsHtml } from './sanitize.js'

export interface NewsContext {
  ip?: string | null
  userAgent?: string | null
}

/** Cover art is decorative — a smaller edge than a letter photo is plenty. */
export const MAX_COVER_BYTES = 6 * 1024 * 1024

/**
 * Thai titles slugify to Thai. That is fine — the slug lives in a URL shared
 * inside LINE, where percent-encoding is invisible to the reader, and a
 * transliteration table would be a whole other subsystem to get wrong.
 *
 * `\p{M}` has to be in the keep-set: Thai vowels and tone marks are combining
 * marks, not letters, and dropping them turns ข่าว into ข-าว.
 */
export function slugify(input: string): string {
  return input
    .normalize('NFC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '')
}

function uniqueSlug(desired: string, excludeId: string | null, database: Db): string {
  const base = desired || 'news'
  for (let n = 0; n < 50; n++) {
    const candidate = n === 0 ? base : `${base}-${n + 1}`
    const clash = database.select({ id: news.id }).from(news).where(eq(news.slug, candidate)).get()
    if (!clash || clash.id === excludeId) return candidate
  }
  throw conflict('สร้าง slug ที่ไม่ซ้ำไม่สำเร็จ กรุณาระบุ slug เอง')
}

export function newsQuery(database: Db = defaultDb()) {
  return database
    .select({
      id: news.id,
      slug: news.slug,
      title: news.title,
      excerpt: news.excerpt,
      coverImageKey: news.coverImageKey,
      bodyHtml: news.bodyHtml,
      status: news.status,
      prisonId: news.prisonId,
      prisonName: prisons.nameTh,
      isPinned: news.isPinned,
      publishedAt: news.publishedAt,
      createdAt: news.createdAt,
      updatedAt: news.updatedAt,
      authorName: staff.fullName
    })
    .from(news)
    .leftJoin(prisons, eq(prisons.id, news.prisonId))
    .leftJoin(staff, eq(staff.id, news.authorStaffId))
    .$dynamic()
}

type QueryRow = ReturnType<ReturnType<typeof newsQuery>['all']>[number]

export function toSummary(row: QueryRow): NewsSummary {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    excerpt: row.excerpt,
    coverImageUrl: row.coverImageKey ? storage().url(row.coverImageKey) : null,
    status: row.status,
    prisonId: row.prisonId,
    prisonName: row.prisonName,
    isPinned: row.isPinned,
    publishedAt: row.publishedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt
  }
}

export function toDetail(row: QueryRow): NewsDetail {
  return {
    ...toSummary(row),
    bodyHtml: row.bodyHtml,
    authorName: row.authorName
  }
}

/**
 * The customer feed. A row with `prison_id` NULL is a department-wide notice
 * and shows everywhere; a prison filter never hides those. A future-dated
 * `published_at` is a scheduled post and stays invisible until its time.
 */
export function publicFilter(prisonId: string | null) {
  return and(
    eq(news.status, 'published'),
    lte(news.publishedAt, now()),
    prisonId ? or(isNull(news.prisonId), eq(news.prisonId, prisonId)) : undefined
  )
}

export function publishedBySlug(slug: string, database: Db = defaultDb()): NewsDetail {
  const row = newsQuery(database)
    .where(and(eq(news.slug, slug), publicFilter(null)))
    .get()
  if (!row) throw notFound('ไม่พบข่าวนี้')
  return toDetail(row)
}

export function newsDetail(id: string, database: Db = defaultDb()): NewsDetail {
  const row = newsQuery(database).where(eq(news.id, id)).get()
  if (!row) throw notFound('ไม่พบข่าวนี้')
  return toDetail(row)
}

/** Feed ordering, shared by the public list and the admin list. */
export const feedOrder = () => [desc(news.isPinned), desc(news.publishedAt), desc(news.id)] as const

/* ── writes ────────────────────────────────────────────────────────────── */

export function createNews(
  actorId: string,
  input: CreateNewsInput & { prisonId: string | null },
  ctx: NewsContext = {},
  database: Db = defaultDb()
): NewsDetail {
  const bodyHtml = sanitizeNewsHtml(input.bodyHtml)
  const at = now()
  const slug = uniqueSlug(input.slug ?? slugify(input.title), null, database)

  const row = database
    .insert(news)
    .values({
      prisonId: input.prisonId,
      title: input.title,
      slug,
      excerpt: input.excerpt?.trim() || deriveExcerpt(bodyHtml),
      bodyHtml,
      status: input.status,
      // `published_at` is the sort key of the whole feed, so it is stamped the
      // moment a row first goes live — not on every later edit.
      publishedAt: input.status === 'published' ? at : null,
      isPinned: input.isPinned,
      authorStaffId: actorId,
      createdBy: actorId,
      updatedBy: actorId
    })
    .returning({ id: news.id })
    .get()

  const detail = newsDetail(row.id, database)
  writeAudit(
    {
      actorType: 'staff',
      actorId,
      action: 'news.create',
      entity: 'news',
      entityId: row.id,
      prisonId: input.prisonId,
      after: { title: detail.title, slug: detail.slug, status: detail.status },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )
  return detail
}

export function updateNews(
  actorId: string,
  id: string,
  input: UpdateNewsInput,
  ctx: NewsContext = {},
  database: Db = defaultDb()
): NewsDetail {
  const before = database.select().from(news).where(eq(news.id, id)).get()
  if (!before) throw notFound('ไม่พบข่าวนี้')

  const bodyHtml = input.bodyHtml === undefined ? undefined : sanitizeNewsHtml(input.bodyHtml)
  const at = now()
  const status = input.status ?? before.status
  const slug =
    input.slug !== undefined
      ? uniqueSlug(input.slug, id, database)
      : input.title !== undefined && before.status === 'draft'
        ? // A draft's slug still tracks its title; a published one never moves,
          // because that URL is already sitting in someone's LINE chat.
          uniqueSlug(slugify(input.title), id, database)
        : before.slug

  database
    .update(news)
    .set({
      title: input.title ?? before.title,
      slug,
      excerpt:
        input.excerpt !== undefined
          ? input.excerpt.trim() || deriveExcerpt(bodyHtml ?? before.bodyHtml)
          : (before.excerpt ?? deriveExcerpt(bodyHtml ?? before.bodyHtml)),
      bodyHtml: bodyHtml ?? before.bodyHtml,
      status,
      publishedAt: status === 'published' ? (before.publishedAt ?? at) : before.publishedAt,
      isPinned: input.isPinned ?? before.isPinned,
      updatedBy: actorId,
      updatedAt: at
    })
    .where(eq(news.id, id))
    .run()

  const detail = newsDetail(id, database)
  writeAudit(
    {
      actorType: 'staff',
      actorId,
      action: 'news.update',
      entity: 'news',
      entityId: id,
      prisonId: before.prisonId,
      before: { title: before.title, slug: before.slug, status: before.status },
      after: { title: detail.title, slug: detail.slug, status: detail.status },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )
  return detail
}

/**
 * Hard delete, and the cover goes with it. News carries no financial or
 * correspondence trail, so there is nothing worth a tombstone here — the audit
 * row records what was removed.
 */
export async function deleteNews(
  actorId: string,
  id: string,
  ctx: NewsContext = {},
  database: Db = defaultDb()
): Promise<void> {
  const row = database.select().from(news).where(eq(news.id, id)).get()
  if (!row) throw notFound('ไม่พบข่าวนี้')

  database.delete(news).where(eq(news.id, id)).run()
  if (row.coverImageKey) await storage().delete(row.coverImageKey)

  writeAudit(
    {
      actorType: 'staff',
      actorId,
      action: 'news.delete',
      entity: 'news',
      entityId: id,
      prisonId: row.prisonId,
      before: { title: row.title, slug: row.slug, status: row.status },
      ip: ctx.ip,
      userAgent: ctx.userAgent
    },
    database
  )
}

export async function setCover(
  actorId: string,
  id: string,
  file: { buffer: Buffer; contentType?: string },
  database: Db = defaultDb()
): Promise<NewsDetail> {
  const row = database.select().from(news).where(eq(news.id, id)).get()
  if (!row) throw notFound('ไม่พบข่าวนี้')

  const image = await normalizeImage(file.buffer, {
    declaredType: file.contentType,
    maxBytes: MAX_COVER_BYTES,
    maxEdge: 1400,
    label: 'ภาพปก'
  })
  const stored = await storage().put(image.buffer, {
    prefix: 'news/covers',
    contentType: image.contentType,
    filename: 'cover.jpg'
  })

  database
    .update(news)
    .set({ coverImageKey: stored.key, updatedBy: actorId, updatedAt: now() })
    .where(eq(news.id, id))
    .run()
  if (row.coverImageKey && row.coverImageKey !== stored.key) {
    await storage().delete(row.coverImageKey)
  }
  return newsDetail(id, database)
}

export async function removeCover(
  actorId: string,
  id: string,
  database: Db = defaultDb()
): Promise<NewsDetail> {
  const row = database.select().from(news).where(eq(news.id, id)).get()
  if (!row) throw notFound('ไม่พบข่าวนี้')
  if (!row.coverImageKey) throw badRequest('ข่าวนี้ไม่มีภาพปก')

  database
    .update(news)
    .set({ coverImageKey: null, updatedBy: actorId, updatedAt: now() })
    .where(eq(news.id, id))
    .run()
  await storage().delete(row.coverImageKey)
  return newsDetail(id, database)
}
