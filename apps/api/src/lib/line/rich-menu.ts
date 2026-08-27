import { env } from '../../env.js'
import type { RichMenuBody } from './client.js'

/**
 * The six tiles of p.8, as a 2×3 grid on LINE's small canvas (2500×843).
 * Every action is a LIFF URI, so a tap lands in the same SPA a browser would
 * open — there is no second front end to keep in sync.
 */
export function richMenuBody(liffId = env().LIFF_ID ?? ''): RichMenuBody {
  const uri = (path: string) => `https://liff.line.me/${liffId}${path}`
  const w = Math.floor(2500 / 3)
  const h = Math.floor(843 / 2)

  const tiles: Array<[label: string, path: string]> = [
    ['สั่งซื้อสินค้า', '/shop'],
    ['ฝากเงิน', '/deposits'],
    ['จดหมาย', '/letters'],
    ['จองเยี่ยม', '/visits'],
    ['ข่าวสาร', '/news'],
    ['บัญชีของฉัน', '/profile']
  ]

  return {
    size: { width: 2500, height: 843 },
    selected: true,
    name: 'ศูนย์บริการญาติผู้ต้องขัง',
    chatBarText: 'เมนูบริการ',
    areas: tiles.map(([label, path], i) => ({
      bounds: { x: (i % 3) * w, y: Math.floor(i / 3) * h, width: w, height: h },
      action: { type: 'uri' as const, label, uri: uri(path) }
    }))
  }
}
