<script lang="ts">
  import { Alert, Button, Card, Field, formatPhone } from '@pc/ui'
  import { api, session, toFormError } from '$lib/session.svelte.js'
  import { bootLiff, liff } from '$lib/liff.svelte.js'
  import type { PrisonDetail, PrisonSummary } from '@pc/contract'

  let prisons = $state<PrisonSummary[]>([])
  let selectedPrison = $state('')
  let detail = $state<PrisonDetail | null>(null)
  let inmateId = $state('')
  let relationship = $state('')
  let loading = $state(false)
  let message = $state('')
  let tone = $state<'danger' | 'success'>('danger')
  let fields = $state<Record<string, string[]>>({})

  let lineEnabled = $state(false)
  let lineBusy = $state(false)
  let lineMessage = $state('')
  let lineTone = $state<'danger' | 'success'>('success')
  let closing = $state(false)
  let confirmClose = $state(false)

  $effect(() => {
    api.settings
      .public()
      .then((s) => {
        lineEnabled = s.features.lineLogin
        if (s.features.lineLogin) void bootLiff()
      })
      .catch(() => {})
  })

  async function toggleLine() {
    lineBusy = true
    lineMessage = ''
    try {
      if (session.me?.lineLinked) {
        await session.unlinkLine()
        liff.logout()
        lineTone = 'success'
        lineMessage = 'ยกเลิกการเชื่อมบัญชี LINE แล้ว'
        return
      }
      const idToken = await liff.idToken()
      // null means the SDK navigated to LINE's consent screen; this page will
      // come back and the user taps again.
      if (!idToken) return
      await session.linkLine(idToken)
      lineTone = 'success'
      lineMessage = 'เชื่อมบัญชี LINE แล้ว ต่อจากนี้จะได้รับแจ้งเตือนทาง LINE'
    } catch (err) {
      lineTone = 'danger'
      lineMessage = toFormError(err).message
    } finally {
      lineBusy = false
    }
  }

  async function closeAccount() {
    closing = true
    try {
      await api.me.closeAccount()
      await session.signOut()
    } catch (err) {
      tone = 'danger'
      message = toFormError(err).message
    } finally {
      closing = false
      confirmClose = false
    }
  }

  $effect(() => {
    api.prisons
      .list()
      .then((r) => (prisons = r.items))
      .catch(() => (prisons = []))
  })

  $effect(() => {
    if (!selectedPrison) {
      detail = null
      return
    }
    api.prisons
      .get(selectedPrison)
      .then((d) => (detail = d))
      .catch(() => (detail = null))
  })

  const STATUS_LABEL = {
    pending: 'รอเจ้าหน้าที่ยืนยัน',
    verified: 'ยืนยันแล้ว',
    rejected: 'ไม่ผ่านการยืนยัน'
  } as const

  const STATUS_TONE = {
    pending: 'bg-warn/15 text-ink',
    verified: 'bg-ok/15 text-ink',
    rejected: 'bg-danger/15 text-ink'
  } as const

  async function link(event: SubmitEvent) {
    event.preventDefault()
    loading = true
    message = ''
    fields = {}
    try {
      await api.request('/me/inmates', {
        method: 'POST',
        body: { inmateId, relationship }
      })
      await session.load()
      tone = 'success'
      message = 'ส่งคำขอแล้ว รอเจ้าหน้าที่ตรวจสอบ'
      inmateId = ''
      relationship = ''
    } catch (err) {
      const e = toFormError(err)
      tone = 'danger'
      message = e.message
      fields = e.fields
    } finally {
      loading = false
    }
  }
</script>

<header class="bg-brand-700 px-5 pt-8 pb-6 text-white">
  <h1 class="text-xl font-semibold">บัญชีของฉัน</h1>
  <p class="text-sm text-brand-100">
    {session.me?.fullName} · {formatPhone(session.me?.phone ?? '')}
  </p>
</header>

<main class="space-y-4 p-4">
  <Card title="ผู้ต้องขังที่ผูกกับบัญชี">
    {#if (session.me?.inmates.length ?? 0) === 0}
      <p class="text-sm text-muted">ยังไม่ได้ผูกกับผู้ต้องขังคนใด</p>
    {:else}
      <ul class="divide-y divide-line">
        {#each session.me?.inmates ?? [] as link (link.id)}
          <li class="flex items-center justify-between gap-3 py-3 first:pt-0 last:pb-0">
            <div>
              <p class="font-medium text-ink">{link.fullName}</p>
              <p class="text-sm text-muted">
                {link.inmateCode} · {link.prisonName}{link.zoneName ? ` · ${link.zoneName}` : ''}
              </p>
            </div>
            <span class="rounded-full px-2.5 py-1 text-xs {STATUS_TONE[link.verifyStatus]}">
              {STATUS_LABEL[link.verifyStatus]}
            </span>
          </li>
        {/each}
      </ul>
    {/if}
  </Card>

  <Card title="เพิ่มผู้ต้องขัง" subtitle="เจ้าหน้าที่จะตรวจสอบก่อนอนุมัติ">
    {#if message}
      <div class="mb-4"><Alert {tone} title={message} /></div>
    {/if}

    <form class="space-y-4" onsubmit={link}>
      <div class="space-y-1.5">
        <label class="block text-sm font-medium text-ink" for="prison">เรือนจำ</label>
        <select
          id="prison"
          bind:value={selectedPrison}
          class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5"
        >
          <option value="">— เลือกเรือนจำ —</option>
          {#each prisons as p (p.id)}
            <option value={p.id}>{p.nameTh}</option>
          {/each}
        </select>
        {#if detail}
          <p class="text-sm text-muted">แดนที่เปิดให้บริการ: {detail.zones.length} แดน</p>
        {/if}
      </div>

      <Field
        label="รหัสประจำตัวผู้ต้องขัง"
        bind:value={inmateId}
        hint="สอบถามรหัสได้จากเจ้าหน้าที่เรือนจำ"
        errors={fields.inmateId}
        required
      />
      <Field
        label="ความสัมพันธ์"
        bind:value={relationship}
        placeholder="เช่น บิดา มารดา พี่ น้อง คู่สมรส"
        errors={fields.relationship}
        required
      />

      <Button type="submit" full {loading}>ส่งคำขอผูกบัญชี</Button>
    </form>
  </Card>

  {#if lineEnabled}
    <Card title="บัญชี LINE" subtitle="เชื่อมไว้เพื่อรับแจ้งเตือนคำสั่งซื้อ การชำระเงิน และการเยี่ยม">
      {#if lineMessage}
        <div class="mb-4"><Alert tone={lineTone} title={lineMessage} /></div>
      {/if}

      {#if session.me?.lineLinked}
        <div class="mb-3 flex items-center gap-3">
          {#if session.me.linePictureUrl}
            <img
              src={session.me.linePictureUrl}
              alt=""
              class="size-10 rounded-full object-cover"
            />
          {/if}
          <div>
            <p class="font-medium text-ink">{session.me.lineDisplayName ?? 'เชื่อมบัญชีแล้ว'}</p>
            <p class="text-sm text-muted">แจ้งเตือนผ่าน LINE เปิดใช้งานอยู่</p>
          </div>
        </div>
      {:else}
        <p class="mb-3 text-sm text-muted">
          ยังไม่ได้เชื่อมบัญชี LINE — ระบบจะแจ้งเตือนในแอปเท่านั้น
        </p>
      {/if}

      <Button
        variant="secondary"
        full
        loading={lineBusy}
        disabled={!liff.available && !session.me?.lineLinked}
        onclick={toggleLine}
      >
        {session.me?.lineLinked ? 'ยกเลิกการเชื่อมบัญชี LINE' : 'เชื่อมบัญชี LINE'}
      </Button>
      {#if !liff.available && !session.me?.lineLinked}
        <p class="mt-2 text-center text-xs text-muted">เปิดหน้านี้ในแอป LINE เพื่อเชื่อมบัญชี</p>
      {/if}
    </Card>
  {/if}

  <Card title="ความปลอดภัย">
    <div class="space-y-3">
      <a class="block text-brand-700" href="/change-password">เปลี่ยนรหัสผ่าน</a>
      <Button variant="secondary" full onclick={() => session.signOut()}>ออกจากระบบ</Button>
    </div>
  </Card>

  <Card title="ปิดบัญชี" subtitle="สิทธิ์ตาม พ.ร.บ. คุ้มครองข้อมูลส่วนบุคคล">
    <p class="mb-3 text-sm text-muted">
      เมื่อขอปิดบัญชี ระบบจะยกเลิกการเข้าใช้งานทันที และลบข้อมูลส่วนบุคคลเมื่อครบระยะเวลาที่กำหนด
      ส่วนประวัติการเงินจะถูกเก็บไว้แบบไม่ระบุตัวตนตามกฎหมายบัญชี
    </p>
    {#if confirmClose}
      <div class="space-y-2">
        <Alert tone="danger" title="ยืนยันการปิดบัญชี? การเข้าใช้งานจะหยุดทันที" />
        <Button variant="danger" full loading={closing} onclick={closeAccount}>
          ยืนยันปิดบัญชี
        </Button>
        <Button variant="secondary" full onclick={() => (confirmClose = false)}>ยกเลิก</Button>
      </div>
    {:else}
      <Button variant="secondary" full onclick={() => (confirmClose = true)}>ขอปิดบัญชี</Button>
    {/if}
  </Card>
</main>
