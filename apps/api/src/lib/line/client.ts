import { env } from '../../env.js'

export class LineApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** LINE answers 429 and 5xx transiently; anything else will never succeed. */
    readonly retryable: boolean
  ) {
    super(message)
    this.name = 'LineApiError'
  }
}

export interface LineTextMessage {
  type: 'text'
  text: string
}

export const textMessage = (text: string): LineTextMessage => ({
  type: 'text',
  // The Messaging API rejects anything longer; truncate rather than fail the
  // whole push for a long letter subject.
  text: text.length > 4900 ? `${text.slice(0, 4897)}…` : text
})

async function call<T>(path: string, init: RequestInit): Promise<T> {
  const e = env()
  if (!e.LINE_MESSAGING_TOKEN) throw new LineApiError(0, 'ยังไม่ได้ตั้งค่า LINE_MESSAGING_TOKEN', false)

  const res = await fetch(`${e.LINE_API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${e.LINE_MESSAGING_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers as Record<string, string> | undefined)
    }
  })

  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new LineApiError(
      res.status,
      `LINE ${init.method ?? 'GET'} ${path} → ${res.status} ${body.slice(0, 300)}`,
      res.status === 429 || res.status >= 500
    )
  }
  const text = await res.text()
  return (text ? JSON.parse(text) : {}) as T
}

/**
 * Push one message set to one user. `to` is the `line_user_id` written by the
 * link flow — a push to a relative who never linked is not an error here,
 * it simply never gets called (the notifier checks first).
 */
export function pushMessage(to: string, messages: LineTextMessage[], retryKey?: string) {
  return call<Record<string, never>>('/v2/bot/message/push', {
    method: 'POST',
    body: JSON.stringify({ to, messages }),
    // LINE dedupes on this key for 24h, so a job retry after a timeout that
    // actually delivered will not send the message twice.
    ...(retryKey ? { headers: { 'X-Line-Retry-Key': retryKey } } : {})
  })
}

export interface RichMenuArea {
  bounds: { x: number; y: number; width: number; height: number }
  action: { type: 'uri'; label: string; uri: string }
}

export interface RichMenuBody {
  size: { width: number; height: number }
  selected: boolean
  name: string
  chatBarText: string
  areas: RichMenuArea[]
}

export const createRichMenu = (body: RichMenuBody) =>
  call<{ richMenuId: string }>('/v2/bot/richmenu', { method: 'POST', body: JSON.stringify(body) })

export const deleteRichMenu = (richMenuId: string) =>
  call<Record<string, never>>(`/v2/bot/richmenu/${richMenuId}`, { method: 'DELETE' })

export const setDefaultRichMenu = (richMenuId: string) =>
  call<Record<string, never>>(`/v2/bot/user/all/richmenu/${richMenuId}`, { method: 'POST' })

/** The image is uploaded to a different host with a raw content type. */
export async function uploadRichMenuImage(richMenuId: string, png: Buffer): Promise<void> {
  const e = env()
  const res = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${e.LINE_MESSAGING_TOKEN ?? ''}`,
      'Content-Type': 'image/png'
    },
    body: new Uint8Array(png)
  })
  if (!res.ok) {
    throw new LineApiError(res.status, `rich menu image upload → ${res.status}`, res.status >= 500)
  }
}
