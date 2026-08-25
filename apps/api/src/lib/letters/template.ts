import { qrDataUrl } from '../payments/slip.js'
import { buddhistYear } from '../time.js'

/**
 * The A4 print sheet (p.6). One letter per sheet, and every sheet carries the
 * `แบบฟอร์มตอบกลับ` QR encoding its own `letter_no` — the template is designed
 * around that QR from day one, because it is the only thing that gets a
 * handwritten reply back to the right family.
 *
 * Rendered as HTML and printed by a real browser. Thai glyph clusters (สระ,
 * วรรณยุกต์ stacking) are shaped correctly by the browser's text engine;
 * pdfkit/pdf-lib fight you on exactly this (§2).
 */

export interface LetterSheet {
  letterNo: string
  createdAt: number
  senderName: string
  recipientName: string
  inmateCode: string | null
  zoneName: string | null
  prisonName: string
  bodyText: string
  /** data: URIs — the PDF must not depend on the network at render time. */
  attachmentDataUris: string[]
}

export interface BatchHeader {
  batchNo: string
  prisonName: string
  zoneName: string | null
  generatedAt: number
}

const escapeHtml = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!
  )

const thaiDate = (tsMs: number) =>
  `${new Intl.DateTimeFormat('th-TH-u-ca-gregory', {
    timeZone: 'Asia/Bangkok',
    day: 'numeric',
    month: 'long'
  }).format(new Date(tsMs))} ${buddhistYear(tsMs)}`

/** What the reply QR carries. Prefixed so a scanner can tell what it read. */
export const replyQrPayload = (letterNo: string) => `PCL:${letterNo}`

const STYLE = `
  @page { size: A4; margin: 14mm 14mm 12mm; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: "Sarabun", "Noto Sans Thai", "TH Sarabun New", "Tahoma", sans-serif;
    font-size: 15px;
    line-height: 1.85;
    color: #111827;
  }
  .sheet { page-break-after: always; }
  .sheet:last-child { page-break-after: auto; }
  .head { display: flex; justify-content: space-between; gap: 16px;
          border-bottom: 2px solid #111827; padding-bottom: 8px; }
  .head h1 { font-size: 17px; margin: 0 0 2px; }
  .meta { font-size: 12.5px; color: #4b5563; line-height: 1.6; }
  .meta b { color: #111827; }
  .qr { text-align: center; width: 30mm; flex: none; }
  .qr img { width: 28mm; height: 28mm; display: block; }
  .qr span { display: block; font-size: 10px; letter-spacing: .04em; color: #4b5563; }
  .no { font-family: "Consolas", "Menlo", monospace; font-size: 13px; }
  .body { margin-top: 10mm; white-space: pre-wrap; word-break: break-word;
          min-height: 105mm; }
  .photos { display: flex; flex-wrap: wrap; gap: 5mm; margin-top: 6mm; }
  .photos img { max-width: 55mm; max-height: 55mm; border: 1px solid #d1d5db; }
  .reply { margin-top: 8mm; border: 1.5px dashed #6b7280; border-radius: 4px;
           padding: 5mm 6mm; page-break-inside: avoid; }
  .reply h2 { font-size: 13px; margin: 0 0 2mm; }
  .reply p { font-size: 11.5px; color: #4b5563; margin: 0 0 4mm; }
  .rule { border-bottom: 1px solid #9ca3af; height: 9mm; }
  .cover { page-break-after: always; }
  .cover h1 { font-size: 22px; margin: 0 0 4mm; }
  .cover table { border-collapse: collapse; width: 100%; font-size: 13px; }
  .cover th, .cover td { border: 1px solid #d1d5db; padding: 2mm 3mm; text-align: left; }
  .cover th { background: #f3f4f6; }
  .foot { margin-top: 4mm; font-size: 10.5px; color: #6b7280;
          border-top: 1px solid #e5e7eb; padding-top: 2mm; }
`

function coverPage(header: BatchHeader, sheets: LetterSheet[]): string {
  const rows = sheets
    .map(
      (s, i) => `<tr>
        <td>${i + 1}</td>
        <td class="no">${escapeHtml(s.letterNo)}</td>
        <td>${escapeHtml(s.recipientName)}</td>
        <td>${escapeHtml(s.inmateCode ?? '—')}</td>
        <td>${escapeHtml(s.zoneName ?? '—')}</td>
        <td>${escapeHtml(s.senderName)}</td>
      </tr>`
    )
    .join('')

  return `<section class="cover">
    <h1>ใบปะหน้ารอบพิมพ์จดหมาย</h1>
    <p class="meta">
      <b>เลขที่รอบพิมพ์</b> ${escapeHtml(header.batchNo)} ·
      <b>เรือนจำ</b> ${escapeHtml(header.prisonName)} ·
      <b>แดน</b> ${escapeHtml(header.zoneName ?? 'ทุกแดน')} ·
      <b>จำนวน</b> ${sheets.length} ฉบับ ·
      <b>พิมพ์เมื่อ</b> ${thaiDate(header.generatedAt)}
    </p>
    <table>
      <thead>
        <tr><th>#</th><th>เลขที่จดหมาย</th><th>ถึงผู้ต้องขัง</th>
            <th>รหัส</th><th>แดน</th><th>จากญาติ</th></tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p class="foot">
      เจ้าหน้าที่ผู้พิมพ์ ............................................
      ลงวันที่ ............................ ·
      ผู้รับมอบเอกสาร ............................................
    </p>
  </section>`
}

function sheetPage(sheet: LetterSheet, qrDataUri: string): string {
  const photos = sheet.attachmentDataUris
    .map((src) => `<img src="${src}" alt="" />`)
    .join('')

  return `<section class="sheet">
    <div class="head">
      <div class="meta">
        <h1>จดหมายอิเล็กทรอนิกส์ · ${escapeHtml(sheet.prisonName)}</h1>
        <div><b>เลขที่</b> <span class="no">${escapeHtml(sheet.letterNo)}</span></div>
        <div><b>ถึง</b> ${escapeHtml(sheet.recipientName)}
          ${sheet.inmateCode ? `(${escapeHtml(sheet.inmateCode)})` : ''}
          ${sheet.zoneName ? ` · ${escapeHtml(sheet.zoneName)}` : ''}</div>
        <div><b>จาก</b> ${escapeHtml(sheet.senderName)}</div>
        <div><b>วันที่</b> ${thaiDate(sheet.createdAt)}</div>
      </div>
      <div class="qr">
        <img src="${qrDataUri}" alt="QR ${escapeHtml(sheet.letterNo)}" />
        <span>สแกนเพื่อตอบกลับ</span>
      </div>
    </div>

    <div class="body">${escapeHtml(sheet.bodyText)}</div>
    ${photos ? `<div class="photos">${photos}</div>` : ''}

    <div class="reply">
      <h2>แบบฟอร์มตอบกลับ (เขียนคำตอบในกรอบนี้ แล้วสแกนทั้งแผ่นส่งกลับ)</h2>
      <p>ห้ามตัดหรือปิดทับ QR ด้านบน — ระบบใช้ QR นั้นในการส่งคำตอบกลับถึงญาติที่ถูกต้อง</p>
      <div class="rule"></div><div class="rule"></div><div class="rule"></div>
      <div class="rule"></div><div class="rule"></div><div class="rule"></div>
    </div>
  </section>`
}

/** The whole batch as one printable document: cover sheet, then one page each. */
export async function renderBatchHtml(
  header: BatchHeader,
  sheets: LetterSheet[]
): Promise<string> {
  const pages: string[] = [coverPage(header, sheets)]
  for (const sheet of sheets) {
    pages.push(sheetPage(sheet, await qrDataUrl(replyQrPayload(sheet.letterNo), 360)))
  }

  return `<!doctype html>
<html lang="th">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(header.batchNo)}</title>
<style>${STYLE}</style>
</head>
<body>${pages.join('\n')}</body>
</html>`
}
