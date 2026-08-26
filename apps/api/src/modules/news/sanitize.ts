import { badRequest } from '../../lib/errors.js'

/**
 * News bodies are the only staff-authored HTML the customer app renders with
 * `{@html}`, so they are sanitized **on write** — once, by the server, before
 * the row exists. Sanitizing at render time means every future reader has to
 * remember to do it, and one that forgets is stored XSS in an app that holds
 * family phone numbers.
 *
 * Allowlist, never a blocklist: anything not named here is dropped.
 */
const ALLOWED: Record<string, readonly string[]> = {
  p: [],
  br: [],
  strong: [],
  b: [],
  em: [],
  i: [],
  u: [],
  s: [],
  h2: [],
  h3: [],
  h4: [],
  ul: [],
  ol: [],
  li: [],
  blockquote: [],
  hr: [],
  figure: [],
  figcaption: [],
  a: ['href', 'title'],
  img: ['src', 'alt']
}

const VOID = new Set(['br', 'hr', 'img'])

/** `javascript:` and `data:` are the two that turn a link into an exploit. */
function safeUrl(value: string, kinds: 'link' | 'image'): string | null {
  const url = value.trim()
  if (url.startsWith('/')) return url // our own storage path
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url)?.[1]?.toLowerCase()
  if (!scheme) return url // relative
  if (kinds === 'link' && (scheme === 'http' || scheme === 'https' || scheme === 'mailto')) {
    return url
  }
  if (kinds === 'image' && (scheme === 'http' || scheme === 'https')) return url
  return null
}

const escapeText = (s: string) =>
  s.replace(/&(?!(?:[a-zA-Z]+|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;').replace(/</g, '&lt;')

const escapeAttr = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

const ATTR = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g
const TAG = /<!--[\s\S]*?-->|<\/?([a-zA-Z][a-zA-Z0-9]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g

export function sanitizeNewsHtml(input: string): string {
  const open: string[] = []
  let out = ''
  let last = 0

  for (const m of input.matchAll(TAG)) {
    out += escapeText(input.slice(last, m.index))
    last = m.index + m[0].length

    const name = m[1]?.toLowerCase()
    if (!name) continue // comment — dropped entirely
    const allowed = ALLOWED[name]
    if (!allowed) continue // script, style, iframe, everything else

    if (m[0].startsWith('</')) {
      const at = open.lastIndexOf(name)
      if (at === -1) continue
      // Close anything left dangling inside it, innermost first.
      for (let i = open.length - 1; i >= at; i--) out += `</${open[i]}>`
      open.length = at
      continue
    }

    let attrs = ''
    for (const a of (m[2] ?? '').matchAll(ATTR)) {
      const key = a[1]!.toLowerCase()
      if (!allowed.includes(key)) continue
      const value = a[2] ?? a[3] ?? a[4] ?? ''
      if (key === 'href' || key === 'src') {
        const url = safeUrl(value, key === 'href' ? 'link' : 'image')
        if (!url) continue
        attrs += ` ${key}="${escapeAttr(url)}"`
        // An external link opened in place inside the LINE webview strands the
        // reader with no way back.
        if (key === 'href' && /^https?:/i.test(url)) {
          attrs += ' target="_blank" rel="noopener noreferrer"'
        }
      } else {
        attrs += ` ${key}="${escapeAttr(value)}"`
      }
    }

    if (VOID.has(name)) {
      out += `<${name}${attrs} />`
    } else {
      out += `<${name}${attrs}>`
      open.push(name)
    }
  }

  out += escapeText(input.slice(last))
  for (let i = open.length - 1; i >= 0; i--) out += `</${open[i]}>`

  const trimmed = out.trim()
  if (!plainText(trimmed) && !/<img\b/i.test(trimmed)) {
    throw badRequest('เนื้อหาข่าวว่างเปล่าหลังจากกรองแท็กที่ไม่อนุญาต')
  }
  return trimmed
}

/** Tags out, entities back to characters, whitespace collapsed. */
export function plainText(html: string): string {
  return html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
}

/** The list card's lead paragraph, when the author did not write one. */
export function deriveExcerpt(html: string, max = 200): string | null {
  const text = plainText(html)
  if (!text) return null
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const lastSpace = cut.lastIndexOf(' ')
  // Thai does not space between words, so a space-cut is only used when there
  // is one late enough to be a real word boundary.
  return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd() + '…'
}
