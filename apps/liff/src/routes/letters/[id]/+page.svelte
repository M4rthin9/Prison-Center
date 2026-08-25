<script lang="ts">
  import type { LetterDetail, LetterStatus } from '@pc/contract'
  import { Alert, Button, Card, formatDateTime } from '@pc/ui'
  import { page } from '$app/state'
  import { api, toFormError } from '$lib/session.svelte.js'

  const STATUS_LABEL: Record<LetterStatus, string> = {
    draft: 'ฉบับร่าง',
    queued: 'รอเจ้าหน้าที่พิมพ์',
    pending_print: 'อยู่ในรอบพิมพ์',
    printed: 'พิมพ์แล้ว',
    dispatched: 'นำส่งแดนแล้ว',
    delivered: 'ถึงมือผู้ต้องขังแล้ว',
    rejected: 'ไม่สำเร็จ'
  }

  let letter = $state<LetterDetail | null>(null)
  let loading = $state(true)
  let working = $state(false)
  let error = $state('')

  const held = $derived(letter?.direction === 'to_home' && letter.status === 'queued')
  const canCancel = $derived(
    letter?.direction === 'to_prison' && ['draft', 'queued'].includes(letter.status)
  )

  async function load() {
    loading = true
    try {
      letter = await api.letters.get(page.params.id!)
    } catch (err) {
      error = toFormError(err).message
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void load()
  })

  async function cancel() {
    if (!letter) return
    working = true
    try {
      letter = await api.letters.cancel(letter.id)
    } catch (err) {
      error = toFormError(err).message
    } finally {
      working = false
    }
  }
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <a class="text-sm text-brand-100" href="/letters">← จดหมาย</a>
  <h1 class="mt-1 text-xl font-semibold">
    {letter?.direction === 'to_home' ? 'จดหมายตอบกลับ' : 'จดหมายที่ส่งไป'}
  </h1>
  {#if letter}<p class="font-mono text-sm text-brand-100">{letter.letterNo}</p>{/if}
</header>

<main class="space-y-4 p-4 pb-24">
  {#if error}<Alert tone="danger" title={error} />{/if}

  {#if loading}
    <p class="py-8 text-center text-muted">กำลังโหลด…</p>
  {:else if letter}
    <Card>
      <dl class="space-y-2 text-sm">
        <div class="flex justify-between gap-4">
          <dt class="text-muted">{letter.direction === 'to_prison' ? 'ถึง' : 'จาก'}</dt>
          <dd class="text-ink">
            {letter.inmateName ?? '—'}{letter.inmateCode ? ` (${letter.inmateCode})` : ''}
          </dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">เรือนจำ / แดน</dt>
          <dd class="text-ink">
            {letter.prisonName ?? '—'}{letter.zoneName ? ` · ${letter.zoneName}` : ''}
          </dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">สถานะ</dt>
          <dd class="text-ink">{held ? 'รอเปิดอ่าน' : STATUS_LABEL[letter.status]}</dd>
        </div>
        <div class="flex justify-between gap-4">
          <dt class="text-muted">เขียนเมื่อ</dt>
          <dd class="text-ink">{formatDateTime(letter.createdAt)}</dd>
        </div>
        {#if letter.printedAt}
          <div class="flex justify-between gap-4">
            <dt class="text-muted">พิมพ์เมื่อ</dt>
            <dd class="text-ink">{formatDateTime(letter.printedAt)}</dd>
          </div>
        {/if}
        {#if letter.deliveredAt}
          <div class="flex justify-between gap-4">
            <dt class="text-muted">ถึงมือเมื่อ</dt>
            <dd class="text-ink">{formatDateTime(letter.deliveredAt)}</dd>
          </div>
        {/if}
        {#if letter.replyToLetterNo}
          <div class="flex justify-between gap-4">
            <dt class="text-muted">ตอบกลับจดหมาย</dt>
            <dd class="font-mono text-ink">{letter.replyToLetterNo}</dd>
          </div>
        {/if}
      </dl>
    </Card>

    {#if letter.status === 'rejected'}
      <Alert tone="danger" title="จดหมายฉบับนี้ไม่ถูกส่ง">
        {letter.rejectedReason ?? 'กรุณาติดต่อเจ้าหน้าที่'}
      </Alert>
    {/if}

    {#if held}
      <Alert tone="warning" title="มีจดหมายตอบกลับรอเปิดอ่าน">
        ซื้อแพ็กเกจ "ส่งกลับบ้าน" เพื่อเปิดอ่านจดหมายลายมือฉบับนี้
        <span class="mt-3 block">
          <a class="text-brand-700 underline" href="/letters">ไปหน้าซื้อแพ็กเกจ →</a>
        </span>
      </Alert>
    {:else if letter.scanUrl}
      <Card title="จดหมายลายมือที่สแกนมา" padded={false}>
        <img src={api.letters.scanUrl(letter.id)} alt="จดหมายตอบกลับ" class="w-full" />
      </Card>
    {/if}

    {#if letter.bodyText}
      <Card title="ข้อความ">
        <p class="whitespace-pre-wrap leading-relaxed text-ink">{letter.bodyText}</p>
      </Card>
    {/if}

    {#if letter.attachments.length > 0}
      <Card title="รูปแนบ">
        <ul class="flex flex-wrap gap-2">
          {#each letter.attachments as att (att.id)}
            <li>
              <img
                src={api.letters.attachmentUrl(letter.id, att.id)}
                alt=""
                class="size-24 rounded-lg border border-line object-cover"
              />
            </li>
          {/each}
        </ul>
      </Card>
    {/if}

    {#if letter.hasReply}
      <Alert tone="success" title="ผู้ต้องขังตอบกลับจดหมายฉบับนี้แล้ว">
        ดูได้ในแท็บ "ตอบกลับถึงบ้าน" ที่หน้าจดหมาย
      </Alert>
    {/if}

    {#if canCancel}
      <Button variant="secondary" full loading={working} onclick={cancel}>
        ยกเลิกจดหมายฉบับนี้ (คืนสิทธิ์ให้ 1 ฉบับ)
      </Button>
    {/if}
  {/if}
</main>
