<script lang="ts">
  import { Alert, Card } from '@pc/ui'
  import { ROLE_LABEL, session } from '$lib/session.svelte.js'

  // The four dashboard tiles (p.11) land in Phase 6, once orders, deposits,
  // letters and visits exist to count.
  const TILES = [
    { label: 'คำสั่งซื้อ', phase: 'เฟส 1–2' },
    { label: 'การจองเยี่ยม', phase: 'เฟส 5' },
    { label: 'จดหมายอิเล็กทรอนิกส์', phase: 'เฟส 4' },
    { label: 'การฝากเงิน', phase: 'เฟส 3' }
  ]
</script>

<div class="space-y-6">
  <div>
    <h1 class="text-2xl font-semibold text-ink">ภาพรวม</h1>
    <p class="text-muted">
      {ROLE_LABEL[session.me?.role ?? ''] ?? ''} · {session.scopeLabel}
    </p>
  </div>

  <Alert tone="info" title="ระบบอยู่ในเฟส 0 — รากฐาน">
    ระบบยืนยันตัวตน การจำกัดขอบเขตตามเรือนจำ ตารางตั้งค่า และ audit log พร้อมใช้งานแล้ว
    ส่วนงานขาย การชำระเงิน การฝากเงิน จดหมาย และการเยี่ยม จะเปิดใช้ตามลำดับเฟส
  </Alert>

  <div class="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
    {#each TILES as tile (tile.label)}
      <Card>
        <p class="text-sm text-muted">{tile.label}</p>
        <p class="mt-1 text-3xl font-semibold text-line">—</p>
        <p class="mt-1 text-xs text-muted">{tile.phase}</p>
      </Card>
    {/each}
  </div>

  <div class="grid gap-4 lg:grid-cols-2">
    <Card title="สิ่งที่ทำได้ตอนนี้">
      <ul class="space-y-2 text-sm text-muted">
        <li>• ตรวจสอบและยืนยันคำขอผูกบัญชีญาติกับผู้ต้องขัง</li>
        <li>• ออกรหัสผ่านชั่วคราวและปลดล็อกบัญชีญาติ</li>
        <li>• จัดการบัญชีเจ้าหน้าที่ (เฉพาะผู้ดูแลระบบส่วนกลาง)</li>
        <li>• แก้ไขค่าตั้งระบบตาม registry ที่ประกาศไว้ในโค้ด</li>
      </ul>
    </Card>
    <Card title="ขอบเขตข้อมูลของคุณ">
      <p class="text-sm text-muted">
        {#if session.isSuperAdmin}
          บัญชีนี้เห็นข้อมูลของทุกเรือนจำ และเป็นบัญชีเดียวที่แก้ค่าตั้งระดับส่วนกลางได้
        {:else}
          บัญชีนี้เห็นเฉพาะข้อมูลของ {session.scopeLabel} เท่านั้น
          การเข้าถึงข้อมูลเรือนจำอื่นจะถูกปฏิเสธที่ระดับ API ไม่ใช่ที่หน้าจอ
        {/if}
      </p>
    </Card>
  </div>
</div>
