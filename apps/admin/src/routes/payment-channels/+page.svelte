<script lang="ts">
  import type {
    CreatePaymentChannelInput,
    PaymentChannel,
    PaymentPurpose,
    PaymentRail,
    PrisonSummary,
    RefMode,
    TargetType
  } from '@pc/contract'
  import {
    PAYMENT_PURPOSE_LABEL,
    PAYMENT_RAIL_LABEL,
    REF_MODE_LABEL,
    TARGET_TYPE_LABEL,
    THAI_BANKS
  } from '@pc/contract'
  import { Alert, Button, Card, Field } from '@pc/ui'
  import { api, session, toFormError } from '$lib/session.svelte.js'

  let rows = $state<PaymentChannel[]>([])
  let prisons = $state<PrisonSummary[]>([])
  let loading = $state(true)
  let message = $state('')
  let tone = $state<'danger' | 'success'>('success')

  let editing = $state<PaymentChannel | null>(null)
  let creating = $state(false)
  let working = $state(false)
  let fieldErrors = $state<Record<string, string[]>>({})
  let formError = $state('')

  const PURPOSES: PaymentPurpose[] = ['order', 'deposit', 'letter_package']
  const RAILS: PaymentRail[] = [
    'promptpay_credit_transfer',
    'promptpay_bill_payment',
    'bank_transfer'
  ]
  const PROXY_TYPES: TargetType[] = ['mobile', 'national_id', 'ewallet_id']
  const REF_MODES: RefMode[] = ['payment_no', 'inmate_code', 'customer_phone', 'none']

  /**
   * The form model is all strings and never null: `Field` two-way binds to a
   * string, and a nullable model would need a mirror variable per input.
   * Nulls are put back on the way out, in `payload()`.
   */
  interface Draft {
    prisonId: string
    rail: PaymentRail
    displayName: string
    priority: string
    isActive: boolean
    billerId: string
    terminalSuffix: string
    ref1Mode: RefMode
    ref2Mode: RefMode
    targetType: TargetType
    targetValue: string
    bankCode: string
    accountNo: string
    accountName: string
    supportsPurposes: PaymentPurpose[]
    amountSaltEnabled: boolean
    ttlMinutes: string
    note: string
  }

  const blank = (): Draft => ({
    prisonId: session.me?.prisonId ?? '',
    rail: 'promptpay_credit_transfer',
    displayName: '',
    priority: '100',
    isActive: true,
    billerId: '',
    terminalSuffix: '',
    ref1Mode: 'payment_no',
    ref2Mode: 'none',
    targetType: 'mobile',
    targetValue: '',
    bankCode: '',
    accountNo: '',
    accountName: '',
    supportsPurposes: ['order'],
    // tag-29 has no reference fields, so salting is on by default there.
    amountSaltEnabled: true,
    ttlMinutes: '30',
    note: ''
  })

  let form = $state<Draft>(blank())

  const nullable = (v: string) => (v.trim() === '' ? null : v.trim())

  const payload = (d: Draft): CreatePaymentChannelInput => ({
    prisonId: d.prisonId || null,
    rail: d.rail,
    displayName: d.displayName.trim(),
    priority: Number(d.priority) || 100,
    isActive: d.isActive,
    billerId: nullable(d.billerId),
    terminalSuffix: nullable(d.terminalSuffix),
    ref1Mode: d.ref1Mode,
    ref2Mode: d.ref2Mode,
    targetType: d.rail === 'bank_transfer' ? 'bank_account' : d.targetType,
    targetValue: nullable(d.targetValue),
    bankCode: nullable(d.bankCode),
    accountNo: nullable(d.accountNo),
    accountName: nullable(d.accountName),
    supportsPurposes: d.supportsPurposes,
    amountSaltEnabled: d.amountSaltEnabled,
    ttlMinutes: Number(d.ttlMinutes) || 30,
    note: nullable(d.note)
  })

  function load() {
    loading = true
    api.admin.paymentChannels
      .list({ includeInactive: true })
      .then((r) => (rows = r.items))
      .catch((err) => {
        tone = 'danger'
        message = toFormError(err).message
      })
      .finally(() => (loading = false))
  }

  $effect(load)
  $effect(() => {
    if (session.isSuperAdmin) api.prisons.list().then((r) => (prisons = r.items))
  })

  function startCreate() {
    form = blank()
    editing = null
    creating = true
    fieldErrors = {}
    formError = ''
  }

  function startEdit(row: PaymentChannel) {
    form = toDraft(row)
    editing = row
    creating = false
    fieldErrors = {}
    formError = ''
  }

  function cancel() {
    editing = null
    creating = false
  }

  function togglePurpose(p: PaymentPurpose) {
    form.supportsPurposes = form.supportsPurposes.includes(p)
      ? form.supportsPurposes.filter((x) => x !== p)
      : [...form.supportsPurposes, p]
  }

  async function save() {
    working = true
    fieldErrors = {}
    formError = ''
    try {
      const body = payload(form)
      if (editing) await api.admin.paymentChannels.update(editing.id, body)
      else await api.admin.paymentChannels.create(body)
      tone = 'success'
      message = editing ? `แก้ไข ${body.displayName} แล้ว` : `เพิ่ม ${body.displayName} แล้ว`
      cancel()
      load()
    } catch (err) {
      const e = toFormError(err)
      formError = e.message
      fieldErrors = e.fields
    } finally {
      working = false
    }
  }

  /** Flipping active must resend the whole channel — PATCH is a full replace. */
  async function toggleActive(row: PaymentChannel) {
    try {
      const d = { ...blank(), ...toDraft(row), isActive: !row.isActive }
      await api.admin.paymentChannels.update(row.id, payload(d))
      load()
    } catch (err) {
      tone = 'danger'
      message = toFormError(err).message
    }
  }

  function toDraft(row: PaymentChannel): Draft {
    return {
      prisonId: row.prisonId ?? '',
      rail: row.rail,
      displayName: row.displayName,
      priority: String(row.priority),
      isActive: row.isActive,
      billerId: row.billerId ?? '',
      terminalSuffix: row.terminalSuffix ?? '',
      ref1Mode: row.ref1Mode,
      ref2Mode: row.ref2Mode,
      targetType: (row.targetType ?? 'mobile') as TargetType,
      targetValue: row.targetValue ?? '',
      bankCode: row.bankCode ?? '',
      accountNo: row.accountNo ?? '',
      accountName: row.accountName ?? '',
      supportsPurposes: row.supportsPurposes,
      amountSaltEnabled: row.amountSaltEnabled,
      ttlMinutes: String(row.ttlMinutes),
      note: row.note ?? ''
    }
  }

  const isBill = $derived(form.rail === 'promptpay_bill_payment')
  const isProxy = $derived(form.rail === 'promptpay_credit_transfer')
  const isBank = $derived(form.rail === 'bank_transfer')
</script>

<div class="space-y-5">
  <div class="flex items-start justify-between gap-4">
    <div>
      <h1 class="text-2xl font-semibold text-ink">ช่องทางชำระเงิน</h1>
      <p class="text-muted">
        เปิดได้มากกว่าหนึ่งช่องทางพร้อมกัน ญาติเลือกเองตอนชำระ
        และช่องทางที่เลือกถูกบันทึกไว้ทุกรายการ
      </p>
    </div>
    <Button onclick={startCreate}>เพิ่มช่องทาง</Button>
  </div>

  {#if message}<Alert {tone} title={message} />{/if}

  <Card padded={false}>
    <div class="overflow-x-auto">
      <table class="admin-table">
        <thead>
          <tr>
            <th>ชื่อช่องทาง</th>
            <th>รูปแบบ</th>
            <th>เรือนจำ</th>
            <th>ปลายทาง</th>
            <th>ใช้กับ</th>
            <th>ลำดับ</th>
            <th>อายุ QR</th>
            <th>สถานะ</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row (row.id)}
            <tr>
              <td>
                <p class="font-medium text-ink">{row.displayName}</p>
                {#if row.note}<p class="text-sm text-muted">{row.note}</p>{/if}
              </td>
              <td class="text-sm">{PAYMENT_RAIL_LABEL[row.rail]}</td>
              <td class="text-sm text-muted">{row.prisonName ?? 'ส่วนกลาง'}</td>
              <td class="font-mono text-sm text-muted">
                {row.rail === 'promptpay_bill_payment'
                  ? row.billerId
                  : (row.targetValue ?? row.accountNo ?? '—')}
              </td>
              <td class="text-sm text-muted">
                {row.supportsPurposes.map((p) => PAYMENT_PURPOSE_LABEL[p]).join(', ')}
              </td>
              <td>{row.priority}</td>
              <td class="text-sm text-muted">{row.ttlMinutes} นาที</td>
              <td>
                <span class={row.isActive ? 'text-ink' : 'text-muted'}>
                  {row.isActive ? 'เปิดใช้งาน' : 'ปิด'}
                </span>
              </td>
              <td class="text-right whitespace-nowrap">
                <Button size="sm" variant="secondary" onclick={() => startEdit(row)}>แก้ไข</Button>
                <Button size="sm" variant="ghost" onclick={() => toggleActive(row)}>
                  {row.isActive ? 'ปิด' : 'เปิด'}
                </Button>
              </td>
            </tr>
          {:else}
            <tr>
              <td colspan="9" class="py-8 text-center text-muted">
                {loading ? 'กำลังโหลด…' : 'ยังไม่มีช่องทางชำระเงิน'}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  </Card>
</div>

{#if creating || editing}
  <div class="fixed inset-0 z-40 flex justify-end bg-black/40">
    <button type="button" class="flex-1 cursor-default" aria-label="ปิด" onclick={cancel}></button>
    <section class="w-full max-w-xl overflow-y-auto bg-canvas p-6">
      <h2 class="mb-4 text-xl font-semibold text-ink">
        {editing ? 'แก้ไขช่องทาง' : 'เพิ่มช่องทางชำระเงิน'}
      </h2>

      {#if formError}<div class="mb-4"><Alert tone="danger" title={formError} /></div>{/if}

      <div class="space-y-4">
        <Card title="ทั่วไป">
          <div class="space-y-3">
            <label class="block space-y-1.5">
              <span class="text-sm font-medium text-ink">รูปแบบ</span>
              <select
                bind:value={form.rail}
                class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-ink"
              >
                {#each RAILS as rail (rail)}
                  <option value={rail}>{PAYMENT_RAIL_LABEL[rail]}</option>
                {/each}
              </select>
            </label>

            <Field
              label="ชื่อที่แสดงกับญาติ"
              bind:value={form.displayName}
              errors={fieldErrors.displayName}
              required
            />

            {#if session.isSuperAdmin}
              <label class="block space-y-1.5">
                <span class="text-sm font-medium text-ink">เรือนจำ</span>
                <select
                  bind:value={form.prisonId}
                  class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-ink"
                >
                  <option value="">ส่วนกลาง (ทุกเรือนจำ)</option>
                  {#each prisons as p (p.id)}
                    <option value={p.id}>{p.nameTh}</option>
                  {/each}
                </select>
              </label>
            {/if}

            <fieldset class="space-y-1.5">
              <legend class="text-sm font-medium text-ink">ใช้กับ</legend>
              <div class="flex flex-wrap gap-3">
                {#each PURPOSES as p (p)}
                  <label class="flex items-center gap-2 text-sm text-ink">
                    <input
                      type="checkbox"
                      checked={form.supportsPurposes.includes(p)}
                      onchange={() => togglePurpose(p)}
                    />
                    {PAYMENT_PURPOSE_LABEL[p]}
                  </label>
                {/each}
              </div>
            </fieldset>
          </div>
        </Card>

        {#if isProxy}
          <Card title="พร้อมเพย์ปลายทาง">
            <div class="space-y-3">
              <label class="block space-y-1.5">
                <span class="text-sm font-medium text-ink">ประเภท</span>
                <select
                  bind:value={form.targetType}
                  class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-ink"
                >
                  {#each PROXY_TYPES as t (t)}
                    <option value={t}>{TARGET_TYPE_LABEL[t]}</option>
                  {/each}
                </select>
              </label>
              <Field
                label="เลขพร้อมเพย์"
                bind:value={form.targetValue}
                errors={fieldErrors.targetValue}
                hint="เบอร์มือถือ 10 หลัก / เลขประจำตัว 13 หลัก / e-Wallet 15 หลัก"
                required
              />
            </div>
          </Card>
        {:else if isBill}
          <Card title="ชำระบิล (tag-30)">
            <div class="space-y-3">
              <Field
                label="Biller ID"
                bind:value={form.billerId}
                errors={fieldErrors.billerId}
                hint="เลขผู้เสียภาษี 13 หลัก (รหัสท้าย 2 หลักกรอกแยกได้)"
                required
              />
              <Field label="รหัสท้าย (Terminal/Suffix)" bind:value={form.terminalSuffix} />
              <label class="block space-y-1.5">
                <span class="text-sm font-medium text-ink">Ref1</span>
                <select
                  bind:value={form.ref1Mode}
                  class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-ink"
                >
                  {#each REF_MODES.filter((m) => m !== 'none') as m (m)}
                    <option value={m}>{REF_MODE_LABEL[m]}</option>
                  {/each}
                </select>
              </label>
              <label class="block space-y-1.5">
                <span class="text-sm font-medium text-ink">Ref2</span>
                <select
                  bind:value={form.ref2Mode}
                  class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-ink"
                >
                  {#each REF_MODES as m (m)}
                    <option value={m}>{REF_MODE_LABEL[m]}</option>
                  {/each}
                </select>
              </label>
            </div>
          </Card>
        {/if}

        <Card title={isBank ? 'บัญชีรับโอน' : 'บัญชีสำหรับกระทบยอด'}>
          <div class="space-y-3">
            <label class="block space-y-1.5">
              <span class="text-sm font-medium text-ink">ธนาคาร</span>
              <select
                bind:value={form.bankCode}
                class="w-full rounded-xl border border-line bg-white px-3.5 py-2.5 text-ink"
              >
                <option value="">— ไม่ระบุ —</option>
                {#each Object.entries(THAI_BANKS) as [code, name] (code)}
                  <option value={code}>{name}</option>
                {/each}
              </select>
            </label>
            <Field
              label="เลขบัญชี"
              bind:value={form.accountNo}
              errors={fieldErrors.accountNo}
              required={isBank}
            />
            <Field label="ชื่อบัญชี" bind:value={form.accountName} required={isBank} />
          </div>
        </Card>

        <Card title="การกระทบยอด">
          <div class="space-y-3">
            {#if !isBill}
              <label class="flex items-start gap-2 text-sm text-ink">
                <input type="checkbox" bind:checked={form.amountSaltEnabled} class="mt-1" />
                <span>
                  เติมเศษสตางค์ 1–99 ให้ยอดแต่ละรายการไม่ซ้ำกัน
                  <span class="block text-muted">
                    รางนี้ไม่มีช่องอ้างอิง — ถ้าไม่เติมเศษ ญาติสองคนที่โอนยอดเท่ากันจะแยกไม่ออก
                  </span>
                </span>
              </label>
            {:else}
              <p class="text-sm text-muted">
                tag-30 มี Ref1 เป็นกุญแจกระทบยอดอยู่แล้ว จึงไม่ต้องเติมเศษสตางค์
              </p>
            {/if}

            <Field
              label="อายุ QR (นาที)"
              type="number"
              bind:value={form.ttlMinutes}
              hint="5–1440 นาที"
            />
            <Field
              label="ลำดับความสำคัญ (น้อย = แสดงก่อน)"
              type="number"
              bind:value={form.priority}
            />
            <Field label="คำอธิบายที่แสดงกับญาติ" bind:value={form.note} />

            <label class="flex items-center gap-2 text-sm text-ink">
              <input type="checkbox" bind:checked={form.isActive} />
              เปิดใช้งาน
            </label>
          </div>
        </Card>

        <div class="flex gap-2">
          <Button loading={working} onclick={save}>บันทึก</Button>
          <Button variant="secondary" onclick={cancel}>ยกเลิก</Button>
        </div>
      </div>
    </section>
  </div>
{/if}
