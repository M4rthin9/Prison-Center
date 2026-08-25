<script lang="ts">
  import type { LetterDetail, PublicSettings } from '@pc/contract'
  import { Alert, Button, Card } from '@pc/ui'
  import { goto } from '$app/navigation'
  import { api, session, toFormError } from '$lib/session.svelte.js'

  let settings = $state<PublicSettings | null>(null)
  let draft = $state<LetterDetail | null>(null)
  let credits = $state(0)

  let inmateId = $state('')
  let bodyText = $state('')
  let working = $state(false)
  let error = $state('')

  const inmates = $derived(session.verifiedInmates)
  const maxChars = $derived(settings?.letter.maxChars ?? 3000)
  const maxPhotos = $derived(settings?.letter.maxAttachments ?? 3)
  const tooLong = $derived(bodyText.length > maxChars)
  const empty = $derived(bodyText.trim() === '' && (draft?.attachmentCount ?? 0) === 0)

  $effect(() => {
    void (async () => {
      try {
        const [s, c] = await Promise.all([api.settings.public(), api.letters.credits()])
        settings = s
        credits = c.balance.toPrison
        inmateId ||= inmates[0]?.inmateId ?? ''
      } catch (err) {
        error = toFormError(err).message
      }
    })()
  })

  /**
   * Attachments need a letter id, so the draft is created on the first photo.
   * A draft costs nothing — the coupon is only spent by `submit`.
   */
  async function ensureDraft(): Promise<LetterDetail> {
    if (draft) {
      if (bodyText !== draft.bodyText) draft = await api.letters.update(draft.id, bodyText)
      return draft
    }
    draft = await api.letters.create({ inmateId, bodyText })
    return draft
  }

  async function addPhoto(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return

    working = true
    error = ''
    try {
      const letter = await ensureDraft()
      draft = await api.letters.addAttachment(letter.id, file, file.name)
    } catch (err) {
      error = toFormError(err).message
    } finally {
      working = false
    }
  }

  async function removePhoto(attachmentId: string) {
    if (!draft) return
    working = true
    try {
      draft = await api.letters.removeAttachment(draft.id, attachmentId)
    } catch (err) {
      error = toFormError(err).message
    } finally {
      working = false
    }
  }

  async function send(event: SubmitEvent) {
    event.preventDefault()
    working = true
    error = ''
    try {
      const letter = await ensureDraft()
      const sent = await api.letters.submit(letter.id)
      await goto(`/letters/${sent.id}`)
    } catch (err) {
      error = toFormError(err).message
    } finally {
      working = false
    }
  }
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <a class="text-sm text-brand-100" href="/letters">← จดหมาย</a>
  <h1 class="mt-1 text-xl font-semibold">เขียนจดหมาย</h1>
  <p class="text-sm text-brand-100">สิทธิ์คงเหลือ {credits} ฉบับ</p>
</header>

<main class="space-y-4 p-4 pb-24">
  {#if error}<Alert tone="danger" title={error} />{/if}

  {#if credits < 1}
    <Alert tone="warning" title="สิทธิ์ส่งจดหมายหมดแล้ว">
      กลับไปหน้าจดหมายเพื่อซื้อแพ็กเกจก่อน แล้วจึงเขียนได้
    </Alert>
  {/if}

  <Card>
    <form class="space-y-3" onsubmit={send}>
      <label class="block space-y-1.5">
        <span class="text-sm font-medium text-ink">ส่งถึง</span>
        <select
          bind:value={inmateId}
          disabled={!!draft}
          class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-ink
                 disabled:bg-canvas"
        >
          {#each inmates as inmate (inmate.inmateId)}
            <option value={inmate.inmateId}>{inmate.fullName} ({inmate.inmateCode})</option>
          {/each}
        </select>
        {#if draft}
          <span class="text-sm text-muted">
            เริ่มร่างไว้แล้ว ({draft.letterNo}) — เปลี่ยนผู้รับได้โดยยกเลิกแล้วเขียนใหม่
          </span>
        {/if}
      </label>

      <label class="block space-y-1.5">
        <span class="text-sm font-medium text-ink">ข้อความ</span>
        <textarea
          bind:value={bodyText}
          rows="12"
          placeholder="เขียนถึงคนที่คุณคิดถึง…"
          class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 leading-relaxed
                 text-ink"></textarea>
        <span class="text-sm {tooLong ? 'text-danger' : 'text-muted'}">
          {bodyText.length.toLocaleString('th-TH')} / {maxChars.toLocaleString('th-TH')} ตัวอักษร · จดหมายจะถูกพิมพ์ลงกระดาษ
          A4 หนึ่งแผ่น
        </span>
      </label>

      <div class="space-y-2">
        <span class="text-sm font-medium text-ink">รูปแนบ (ไม่เกิน {maxPhotos} รูป)</span>
        {#if draft && draft.attachments.length > 0}
          <ul class="flex flex-wrap gap-2">
            {#each draft.attachments as att (att.id)}
              <li class="relative">
                <img
                  src={api.letters.attachmentUrl(draft.id, att.id)}
                  alt=""
                  class="size-20 rounded-lg border border-line object-cover"
                />
                <button
                  type="button"
                  aria-label="ลบรูป"
                  class="absolute -top-2 -right-2 size-6 rounded-full bg-danger text-white"
                  onclick={() => removePhoto(att.id)}
                >
                  ×
                </button>
              </li>
            {/each}
          </ul>
        {/if}
        {#if (draft?.attachmentCount ?? 0) < maxPhotos}
          <label
            class="flex h-11 cursor-pointer items-center justify-center rounded-xl border
                   border-dashed border-line text-sm text-brand-700"
          >
            เพิ่มรูป
            <input type="file" accept="image/*" class="hidden" onchange={addPhoto} />
          </label>
        {/if}
      </div>

      <Alert tone="info" title="จดหมายจะถูกพิมพ์และตรวจโดยเจ้าหน้าที่">
        แผ่นที่พิมพ์จะมี QR สำหรับให้ผู้ต้องขังเขียนตอบกลับ แล้วสแกนส่งกลับมาที่แอปนี้
      </Alert>

      <Button type="submit" full loading={working} disabled={empty || tooLong || credits < 1}>
        ส่งเข้าคิวพิมพ์ (ใช้สิทธิ์ 1 ฉบับ)
      </Button>
    </form>
  </Card>
</main>
