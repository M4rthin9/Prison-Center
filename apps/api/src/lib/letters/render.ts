import { env } from '../../env.js'

/**
 * Turning the print HTML into paper-ready bytes. A seam, like `SlipVerifier`
 * and `AuthProvider`: the batch job knows it gets a file back and does not know
 * what drew it.
 *
 * - `playwright` — a real Chromium prints the A4 PDF. Thai glyph clusters are
 *   shaped by the browser's text engine, which is the whole reason §2 picked
 *   Playwright over pdfkit.
 * - `html` — the same document, stored as HTML for the operator to print from
 *   a browser (Ctrl-P → A4 → Save as PDF). Identical layout, same `@page` rule,
 *   no 300 MB browser download on a machine that does not have one.
 *
 * `auto` (the default) uses Playwright when it is installed and falls back
 * rather than failing the batch: a facility with a queue of letters and no
 * browser binary still gets something it can put on a printer today.
 */

export type LetterRenderFormat = 'pdf' | 'html'

export interface RenderedBatch {
  format: LetterRenderFormat
  body: Buffer
  contentType: string
  extension: string
  /** Set when the requested renderer was unavailable and we fell back. */
  fallbackReason?: string
}

export interface LetterRenderer {
  readonly kind: 'playwright' | 'html' | 'auto'
  render(html: string): Promise<RenderedBatch>
}

const htmlResult = (html: string, fallbackReason?: string): RenderedBatch => ({
  format: 'html',
  body: Buffer.from(html, 'utf8'),
  contentType: 'text/html; charset=utf-8',
  extension: 'html',
  ...(fallbackReason ? { fallbackReason } : {})
})

export const htmlRenderer: LetterRenderer = {
  kind: 'html',
  render: async (html) => htmlResult(html)
}

/**
 * Imported through a variable specifier on purpose: `playwright` is not a
 * dependency of this package. Install it on the box that prints —
 * `pnpm --filter @pc/api add playwright && pnpm --filter @pc/api exec playwright install chromium`
 * — and this renderer starts working with no code change.
 */
async function loadChromium(): Promise<{
  launch(opts?: unknown): Promise<any>
} | null> {
  try {
    const specifier = 'playwright'
    const mod = (await import(specifier)) as { chromium?: { launch(opts?: unknown): Promise<any> } }
    return mod.chromium ?? null
  } catch {
    return null
  }
}

export const playwrightRenderer: LetterRenderer = {
  kind: 'playwright',
  async render(html) {
    const chromium = await loadChromium()
    if (!chromium) throw new Error('playwright is not installed')

    const browser = await chromium.launch({ args: ['--no-sandbox'] })
    try {
      const page = await browser.newPage()
      // `networkidle` would hang: every image in the document is a data: URI
      // and there is no network to go idle.
      await page.setContent(html, { waitUntil: 'load' })
      await page.emulateMedia({ media: 'print' })
      const pdf: Buffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        preferCSSPageSize: true
      })
      return {
        format: 'pdf' as const,
        body: Buffer.from(pdf),
        contentType: 'application/pdf',
        extension: 'pdf'
      }
    } finally {
      await browser.close()
    }
  }
}

export const autoRenderer: LetterRenderer = {
  kind: 'auto',
  async render(html) {
    try {
      return await playwrightRenderer.render(html)
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err)
      console.warn(`[letters] PDF renderer unavailable, storing printable HTML — ${why}`)
      return htmlResult(html, why)
    }
  }
}

const BY_KIND: Record<string, LetterRenderer> = {
  playwright: playwrightRenderer,
  html: htmlRenderer,
  auto: autoRenderer
}

let override: LetterRenderer | null = null

/** Tests (and a facility that wants HTML on purpose) pin the renderer here. */
export function setLetterRenderer(renderer: LetterRenderer | null) {
  override = renderer
}

export function letterRenderer(): LetterRenderer {
  if (override) return override
  return BY_KIND[env().LETTER_RENDERER] ?? autoRenderer
}
