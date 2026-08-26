import { describe, expect, it } from 'vitest'
import { BASE, loginStaff, setupApp } from './helpers.js'

const ctx = setupApp()
const app = () => ctx.app

const { sanitizeNewsHtml, deriveExcerpt } = await import('../src/modules/news/sanitize.js')
const { slugify } = await import('../src/modules/news/service.js')

const superAdmin = async () => (await loginStaff(app(), 'superadmin')).client
const prisonAdmin = async () => (await loginStaff(app(), 'klp.admin')).client

const draft = (over: Record<string, unknown> = {}) => ({
  title: 'ประกาศเวลาเยี่ยมญาติเดือนนี้',
  bodyHtml: '<p>เรือนจำเปิดให้เยี่ยมตามรอบปกติ</p>',
  ...over
})

/* ── the sanitizer ─────────────────────────────────────────────────────── */

describe('sanitizeNewsHtml', () => {
  it('keeps the allowlisted formatting tags', () => {
    const out = sanitizeNewsHtml('<p>สวัสดี <strong>ญาติ</strong><br />ทุกท่าน</p>')
    expect(out).toBe('<p>สวัสดี <strong>ญาติ</strong><br />ทุกท่าน</p>')
  })

  it('drops script tags and their content is escaped, not executed', () => {
    const out = sanitizeNewsHtml('<p>ok</p><script>alert(1)</script>')
    expect(out).not.toContain('<script')
    expect(out).toContain('alert(1)')
  })

  it('strips event handlers and javascript: urls', () => {
    const out = sanitizeNewsHtml(
      '<p onclick="steal()">x</p><a href="javascript:alert(1)">คลิก</a>'
    )
    expect(out).not.toContain('onclick')
    expect(out).not.toContain('javascript:')
    expect(out).toContain('<a>คลิก</a>')
  })

  it('opens external links in a new tab so the LINE webview is not hijacked', () => {
    const out = sanitizeNewsHtml('<a href="https://correct.go.th">เว็บกรม</a>')
    expect(out).toContain('rel="noopener noreferrer"')
    expect(out).toContain('target="_blank"')
  })

  it('closes tags the author left dangling', () => {
    expect(sanitizeNewsHtml('<p>หนึ่ง<p>สอง')).toBe('<p>หนึ่ง<p>สอง</p></p>')
  })

  it('keeps Thai tone marks in the slug rather than turning them into dashes', () => {
    expect(slugify('ประกาศข่าวสาร')).toBe('ประกาศข่าวสาร')
  })

  it('rejects a body that is empty once the tags are gone', () => {
    expect(() => sanitizeNewsHtml('<div><span></span></div>')).toThrow()
  })

  it('derives an excerpt from the body text', () => {
    expect(deriveExcerpt('<p>ประกาศ</p><p>เรื่องเวลาเยี่ยม</p>')).toBe('ประกาศ เรื่องเวลาเยี่ยม')
    expect(deriveExcerpt('<p>' + 'ก'.repeat(400) + '</p>')?.endsWith('…')).toBe(true)
  })
})

/* ── admin CRUD ────────────────────────────────────────────────────────── */

describe('admin news', () => {
  it('creates a draft that the public feed does not show', async () => {
    const staff = await prisonAdmin()
    const created = (await staff.json(`${BASE}/admin/news`, {
      method: 'POST',
      json: draft()
    })) as any
    expect(created.status).toBe('draft')
    expect(created.slug).toBeTruthy()
    expect(created.excerpt).toBeTruthy()
    expect(created.prisonId).not.toBeNull()

    const feed = (await ctx.client().json(`${BASE}/news`)) as any
    expect(feed.items.find((n: any) => n.id === created.id)).toBeUndefined()
  })

  it('publishes, stamps publishedAt once, and shows up in the public feed', async () => {
    const staff = await prisonAdmin()
    const created = (await staff.json(`${BASE}/admin/news`, {
      method: 'POST',
      json: draft({ title: 'เปิดรับฝากเงินผ่านพร้อมเพย์', status: 'published' })
    })) as any
    expect(created.publishedAt).toBeGreaterThan(0)

    const edited = (await staff.json(`${BASE}/admin/news/${created.id}`, {
      method: 'PATCH',
      json: { title: 'เปิดรับฝากเงินผ่านพร้อมเพย์ (แก้ไข)' }
    })) as any
    // Republishing must not move the row to the top of the feed.
    expect(edited.publishedAt).toBe(created.publishedAt)
    // …and the slug stays put, because that URL is already shared.
    expect(edited.slug).toBe(created.slug)

    const detail = (await ctx.client().json(`${BASE}/news/${created.slug}`)) as any
    expect(detail.title).toBe('เปิดรับฝากเงินผ่านพร้อมเพย์ (แก้ไข)')
    expect(detail.bodyHtml).toContain('<p>')
  })

  it('gives a second post with the same title a distinct slug', async () => {
    const staff = await prisonAdmin()
    const one = (await staff.json(`${BASE}/admin/news`, {
      method: 'POST',
      json: draft({ title: 'หัวข้อซ้ำ' })
    })) as any
    const two = (await staff.json(`${BASE}/admin/news`, {
      method: 'POST',
      json: draft({ title: 'หัวข้อซ้ำ' })
    })) as any
    expect(two.slug).not.toBe(one.slug)
  })

  it('refuses a prison admin writing a department-wide notice', async () => {
    const staff = await prisonAdmin()
    const res = await staff.request(`${BASE}/admin/news`, {
      method: 'POST',
      json: draft({ prisonId: null })
    })
    expect(res.status).toBe(403)
  })

  it('shows a department-wide notice from every prison', async () => {
    const boss = await superAdmin()
    const created = (await boss.json(`${BASE}/admin/news`, {
      method: 'POST',
      json: draft({ title: 'ประกาศกรมราชทัณฑ์', prisonId: null, status: 'published' })
    })) as any
    expect(created.prisonId).toBeNull()

    const prisons = (await ctx.client().json(`${BASE}/prisons`)) as any
    for (const prison of prisons.items) {
      const feed = (await ctx.client().json(`${BASE}/news?prisonId=${prison.id}`)) as any
      expect(feed.items.some((n: any) => n.id === created.id)).toBe(true)
    }
  })

  it('deletes a post and the public URL stops resolving', async () => {
    const staff = await prisonAdmin()
    const created = (await staff.json(`${BASE}/admin/news`, {
      method: 'POST',
      json: draft({ title: 'ประกาศชั่วคราว', status: 'published' })
    })) as any

    expect((await staff.request(`${BASE}/admin/news/${created.id}`, { method: 'DELETE' })).status)
      .toBe(200)
    expect((await ctx.client().request(`${BASE}/news/${created.slug}`)).status).toBe(404)
  })

  it('keeps a letter operator out of the editor', async () => {
    const { client } = await loginStaff(app(), 'klp.letters')
    const res = await client.request(`${BASE}/admin/news`, { method: 'POST', json: draft() })
    expect(res.status).toBe(403)
  })
})
