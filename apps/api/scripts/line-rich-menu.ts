/**
 * Creates (or replaces) the LINE rich menu and makes it the default for every
 * follower. Run once per environment, after `LIFF_ID` and
 * `LINE_MESSAGING_TOKEN` are set:
 *
 *   pnpm --filter @pc/api rich-menu -- ./menu.png
 *
 * The image is a 2500×843 PNG whose six tiles line up with `richMenuBody()`.
 * The id is written back into the settings registry (`line.rich_menu_id`), so
 * the next run can delete the menu it replaces instead of leaking them.
 */
import fs from 'node:fs'
import { db, runMigrations } from '../src/db/client.js'
import { env } from '../src/env.js'
import {
  createRichMenu,
  deleteRichMenu,
  setDefaultRichMenu,
  uploadRichMenuImage
} from '../src/lib/line/client.js'
import { richMenuBody } from '../src/lib/line/rich-menu.js'
import { getSetting, setSetting } from '../src/modules/settings/service.js'

const imagePath = process.argv[2]
if (!imagePath) {
  console.error('usage: rich-menu <image.png>')
  process.exit(1)
}

const e = env()
if (!e.LINE_MESSAGING_TOKEN) throw new Error('LINE_MESSAGING_TOKEN is not set')
if (!e.LIFF_ID) throw new Error('LIFF_ID is not set — every tile is a LIFF URI')

runMigrations(db())

const previous = getSetting('line.rich_menu_id', { db: db() })
const { richMenuId } = await createRichMenu(richMenuBody(e.LIFF_ID))
console.log(`[rich-menu] created ${richMenuId}`)

await uploadRichMenuImage(richMenuId, fs.readFileSync(imagePath))
await setDefaultRichMenu(richMenuId)
console.log('[rich-menu] set as default for all followers')

setSetting('line.rich_menu_id', richMenuId, { actorLabel: 'script:rich-menu', db: db() })

if (previous && previous !== richMenuId) {
  // Only after the new one is live: a failed upload must not leave followers
  // with no menu at all.
  await deleteRichMenu(previous).catch((err) =>
    console.warn(`[rich-menu] could not delete ${previous}:`, err)
  )
  console.log(`[rich-menu] removed previous ${previous}`)
}
