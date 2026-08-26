import { z } from 'zod'
import { Ulid } from './common.js'

/** §4.7 — ประกาศและข่าวสารจากเรือนจำ. */
export const NewsStatus = z.enum(['draft', 'published', 'archived'])
export type NewsStatus = z.infer<typeof NewsStatus>

/**
 * Lowercase, dash-separated, letters/digits/combining marks — Thai vowels and
 * tone marks are marks, not letters. Generated from the title when blank.
 */
export const NewsSlug = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(/^[\p{L}\p{N}\p{M}]+(?:-[\p{L}\p{N}\p{M}]+)*$/u, 'slug ต้องเป็นตัวอักษร ตัวเลข และขีดกลางเท่านั้น')

export const NewsSummary = z.object({
  id: Ulid,
  slug: z.string(),
  title: z.string(),
  excerpt: z.string().nullable(),
  coverImageUrl: z.string().nullable(),
  status: NewsStatus,
  /** NULL = ประกาศส่วนกลาง — shown from every prison. */
  prisonId: Ulid.nullable(),
  prisonName: z.string().nullable(),
  isPinned: z.boolean(),
  publishedAt: z.number().nullable(),
  createdAt: z.number(),
  updatedAt: z.number()
})
export type NewsSummary = z.infer<typeof NewsSummary>

export const NewsDetail = NewsSummary.extend({
  /** Sanitized server-side on write; safe to render with `{@html}`. */
  bodyHtml: z.string(),
  authorName: z.string().nullable()
})
export type NewsDetail = z.infer<typeof NewsDetail>

export const CreateNewsInput = z.object({
  title: z.string().trim().min(1).max(200),
  slug: NewsSlug.optional(),
  excerpt: z.string().trim().max(400).optional(),
  bodyHtml: z.string().trim().min(1).max(60_000),
  /** Omitted = the author's own prison; explicit `null` = department-wide. */
  prisonId: Ulid.nullable().optional(),
  status: NewsStatus.default('draft'),
  isPinned: z.boolean().default(false)
})
export type CreateNewsInput = z.infer<typeof CreateNewsInput>

/**
 * Spelled out rather than `CreateNewsInput.partial()`: the create schema's
 * `.default()` values survive `.partial()`, so a PATCH that only changes the
 * title would silently push a published post back to draft.
 */
export const UpdateNewsInput = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  slug: NewsSlug.optional(),
  excerpt: z.string().trim().max(400).optional(),
  bodyHtml: z.string().trim().min(1).max(60_000).optional(),
  status: NewsStatus.optional(),
  isPinned: z.boolean().optional()
})
export type UpdateNewsInput = z.infer<typeof UpdateNewsInput>
