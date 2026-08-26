import { index, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core'
import { bool, id, timestamps, ts } from './_shared.js'
import { prisons } from './facility.js'
import { staff } from './people.js'

/**
 * §4.7 — ข่าวสาร. Announcements the relatives' app reads without a session.
 * `prison_id` NULL is a department-wide notice; anything else is scoped like
 * every other business row, and the customer app filters on the prison it is
 * currently browsing.
 */
export type NewsStatus = 'draft' | 'published' | 'archived'

export const news = sqliteTable(
  'news',
  {
    id: id(),
    /** NULL = ประกาศส่วนกลาง, visible from every prison. */
    prisonId: text('prison_id').references(() => prisons.id, { onDelete: 'restrict' }),
    title: text('title').notNull(),
    /** Stable public identifier — `/news/:slug`, never the ULID. */
    slug: text('slug').notNull(),
    /** Plain-text lead shown in the list; derived from the body when blank. */
    excerpt: text('excerpt'),
    coverImageKey: text('cover_image_key'),
    /** Sanitized server-side on write — see modules/news/sanitize.ts. */
    bodyHtml: text('body_html').notNull(),
    status: text('status').$type<NewsStatus>().notNull().default('draft'),
    /** Set the first time it goes live; kept across archive/republish. */
    publishedAt: ts('published_at'),
    isPinned: bool('is_pinned', false),
    authorStaffId: text('author_staff_id').references(() => staff.id, { onDelete: 'set null' }),
    ...timestamps(),
    createdBy: text('created_by'),
    updatedBy: text('updated_by')
  },
  (t) => [
    uniqueIndex('uq_news_slug').on(t.slug),
    // The customer list query: published rows for one prison (or department
    // wide), newest first, pinned on top.
    index('idx_news_feed').on(t.status, t.prisonId, t.isPinned, t.publishedAt),
    index('idx_news_admin').on(t.prisonId, t.createdAt)
  ]
)
