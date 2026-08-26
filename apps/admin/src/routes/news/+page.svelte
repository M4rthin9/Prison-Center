<script lang="ts">
  import type { NewsDetail, NewsStatus, NewsSummary } from '@pc/contract'
  import { Alert, Button, Card, Field, formatDateTime } from '@pc/ui'
  import { api, session, toFormError } from '$lib/session.svelte.js'

  const STATUS_LABEL: Record<NewsStatus, string> = {
    draft: 'ฉบับร่าง',
    published: 'เผยแพร่แล้ว',
    archived: 'เก็บเข้าคลัง'
  }
  const TABS: { key: NewsStatus | ''; label: string }[] = [
    { key: '', label: 'ทั้งหมด' },
    { key: 'published', label: 'เผยแพร่แล้ว' },
    { key: 'draft', label: 'ฉบับร่าง' },
    { key: 'archived', label: 'เก็บเข้าคลัง' }
  ]

  let status = $state<NewsStatus | ''>('')
  let q = $state('')
  let rows = $state<NewsSummary[]>([])
  let nextCursor = $state<string | null>(null)
  let loading = $state(true)
  let busyId = $state<string | null>(null)
  let message = $state('')
  let tone = $state<'danger' | 'success'>('success')

  /** The editor: `null` = closed, a detail = editing, `'new'` = composing. */
  let editing = $state<NewsDetail | 'new' | null>(null)
  let form = $state({ title: '', excerpt: '', bodyHtml: '', departmentWide: false })
  let saving = $state(false)
  let fieldErrors = $state<Record<string, string[]>>({})

  const canEdit = $derived(['super_admin', 'prison_admin'].includes(session.me?.role ?? ''))

  function say(text: string, kind: 'danger' | 'success' = 'success') {
    tone = kind
    message = text
  }

  async function load(cursor?: string) {
    loading = true
    try {
      const page = await api.admin.news.list({
        status: status || undefined,
        q: q.trim() || undefined,
        cursor,
        limit: 50
      })
      rows = cursor ? [...rows, ...page.items] : page.items
      nextCursor = page.nextCursor
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void status
    const term = q
    const timer = setTimeout(() => void load(), term ? 250 : 0)
    return () => clearTimeout(timer)
  })

  function compose() {
    editing = 'new'
    fieldErrors = {}
    form = { title: '', excerpt: '', bodyHtml: '<p></p>', departmentWide: false }
  }

  async function edit(row: NewsSummary) {
    busyId = row.id
    try {
      const detail = await api.admin.news.get(row.id)
      editing = detail
      fieldErrors = {}
      form = {
        title: detail.title,
        excerpt: detail.excerpt ?? '',
        bodyHtml: detail.bodyHtml,
        departmentWide: detail.prisonId === null
      }
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busyId = null
    }
  }

  async function save(next: NewsStatus) {
    saving = true
    fieldErrors = {}
    try {
      if (editing === 'new') {
        const created = await api.admin.news.create({
          title: form.title,
          excerpt: form.excerpt || undefined,
          bodyHtml: form.bodyHtml,
          // Explicit null is the department-wide notice; omitting it means
          // "my prison".
          ...(form.departmentWide ? { prisonId: null } : {}),
          status: next,
          isPinned: false
        })
        say(`บันทึก "${created.title}" เป็น${STATUS_LABEL[created.status]}แล้ว`)
      } else if (editing) {
        const updated = await api.admin.news.update(editing.id, {
          title: form.title,
          excerpt: form.excerpt,
          bodyHtml: form.bodyHtml,
          status: next
        })
        say(`บันทึก "${updated.title}" เป็น${STATUS_LABEL[updated.status]}แล้ว`)
      }
      editing = null
      await load()
    } catch (err) {
      const parsed = toFormError(err)
      fieldErrors = parsed.fields
      say(parsed.message, 'danger')
    } finally {
      saving = false
    }
  }

  async function togglePin(row: NewsSummary) {
    busyId = row.id
    try {
      await api.admin.news.update(row.id, { isPinned: !row.isPinned })
      await load()
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busyId = null
    }
  }

  async function remove(row: NewsSummary) {
    if (!confirm(`ลบข่าว "${row.title}" ถาวร?`)) return
    busyId = row.id
    try {
      await api.admin.news.remove(row.id)
      say(`ลบ "${row.title}" แล้ว`)
      await load()
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busyId = null
    }
  }

  async function uploadCover(row: NewsSummary, files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    busyId = row.id
    try {
      await api.admin.news.setCover(row.id, file, file.name)
      say(`อัปโหลดภาพปกของ "${row.title}" แล้ว`)
      await load()
    } catch (err) {
      say(toFormError(err).message, 'danger')
    } finally {
      busyId = null
    }
  }
</script>

<div class="space-y-5">
  <div class="flex flex-wrap items-end justify-between gap-3">
    <div>
      <h1 class="text-2xl font-semibold text-ink">ข่าวสาร</h1>
      <p class="text-muted">
        ประกาศที่ญาติเห็นในแอป — {session.scopeLabel} · ประกาศส่วนกลางแสดงในทุกเรือนจำ
      </p>
    </div>
    {#if canEdit}
      <Button onclick={compose}>เขียนข่าวใหม่</Button>
    {/if}
  </div>

  {#if message}
    <Alert {tone} title={message} />
  {/if}

  {#if editing}
    <Card
      title={editing === 'new' ? 'เขียนข่าวใหม่' : 'แก้ไขข่าว'}
      subtitle="เนื้อหารองรับ HTML อย่างง่าย (p, strong, em, ul, li, h2, a, img) แท็กอื่นจะถูกตัดออกตอนบันทึก"
    >
      <div class="space-y-4">
        <Field label="หัวข้อ" bind:value={form.title} required errors={fieldErrors.title} />
        <Field
          label="เกริ่นนำ"
          bind:value={form.excerpt}
          hint="เว้นว่างไว้ระบบจะตัดจากเนื้อหาให้เอง"
          errors={fieldErrors.excerpt}
        />

        <div>
          <label class="mb-1 block text-sm font-medium text-ink" for="news-body">เนื้อหา</label>
          <textarea
            id="news-body"
            bind:value={form.bodyHtml}
            rows="10"
            class="w-full rounded-xl border border-line bg-white px-3 py-2 font-mono text-sm text-ink"
          ></textarea>
          {#each fieldErrors.bodyHtml ?? [] as err (err)}
            <p class="mt-1 text-sm text-danger">{err}</p>
          {/each}
        </div>

        {#if editing === 'new' && session.isSuperAdmin}
          <label class="flex items-center gap-2 text-sm text-ink">
            <input type="checkbox" bind:checked={form.departmentWide} />
            ประกาศส่วนกลาง (แสดงในทุกเรือนจำ)
          </label>
        {/if}

        <div class="flex flex-wrap gap-2">
          <Button loading={saving} onclick={() => save('published')}>เผยแพร่</Button>
          <Button variant="ghost" loading={saving} onclick={() => save('draft')}>
            บันทึกเป็นฉบับร่าง
          </Button>
          {#if editing !== 'new'}
            <Button variant="ghost" loading={saving} onclick={() => save('archived')}>
              เก็บเข้าคลัง
            </Button>
          {/if}
          <Button variant="ghost" onclick={() => (editing = null)}>ปิด</Button>
        </div>
      </div>
    </Card>
  {/if}

  <div class="flex flex-wrap items-center gap-2">
    {#each TABS as tab (tab.key)}
      <button
        type="button"
        class="rounded-full border px-3 py-1.5 text-sm transition
               {status === tab.key
          ? 'border-brand-200 bg-brand-50 font-medium text-brand-800'
          : 'border-line bg-surface text-muted hover:text-ink'}"
        onclick={() => (status = tab.key)}
      >
        {tab.label}
      </button>
    {/each}

    <input
      type="search"
      bind:value={q}
      placeholder="ค้นหาจากหัวข้อ"
      class="ml-auto w-64 rounded-xl border border-line bg-white px-3 py-2 text-sm text-ink"
    />
  </div>

  <Card padded={false}>
    <div class="overflow-x-auto">
      <table class="admin-table">
        <thead>
          <tr>
            <th>หัวข้อ</th>
            <th>ขอบเขต</th>
            <th>สถานะ</th>
            <th>เผยแพร่เมื่อ</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr>
              <td>
                <div class="flex items-center gap-3">
                  {#if row.coverImageUrl}
                    <img
                      src={row.coverImageUrl}
                      alt=""
                      class="h-10 w-16 rounded-lg object-cover"
                    />
                  {/if}
                  <div>
                    <p class="font-medium text-ink">
                      {#if row.isPinned}<span aria-label="ปักหมุด">📌</span>{/if}
                      {row.title}
                    </p>
                    <p class="text-sm text-muted">/{row.slug}</p>
                  </div>
                </div>
              </td>
              <td>{row.prisonName ?? 'ส่วนกลาง'}</td>
              <td>{STATUS_LABEL[row.status]}</td>
              <td class="text-muted">{formatDateTime(row.publishedAt)}</td>
              <td class="text-right whitespace-nowrap">
                {#if canEdit}
                  <Button size="sm" variant="ghost" loading={busyId === row.id} onclick={() => edit(row)}>
                    แก้ไข
                  </Button>
                  <Button size="sm" variant="ghost" onclick={() => togglePin(row)}>
                    {row.isPinned ? 'เลิกปักหมุด' : 'ปักหมุด'}
                  </Button>
                  <label class="cursor-pointer text-sm text-brand-700 hover:underline">
                    ภาพปก
                    <input
                      type="file"
                      accept="image/*"
                      class="hidden"
                      onchange={(e) => uploadCover(row, e.currentTarget.files)}
                    />
                  </label>
                  <Button size="sm" variant="ghost" onclick={() => remove(row)}>ลบ</Button>
                {:else}
                  <span class="text-sm text-muted">—</span>
                {/if}
              </td>
            </tr>
          {:else}
            <tr>
              <td colspan="5" class="py-10 text-center text-muted">
                {loading ? 'กำลังโหลด…' : 'ยังไม่มีข่าวในขอบเขตนี้'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Card>

  {#if nextCursor}
    <div class="text-center">
      <Button variant="ghost" loading={loading} onclick={() => load(nextCursor ?? undefined)}>
        โหลดเพิ่ม
      </Button>
    </div>
  {/if}
</div>
