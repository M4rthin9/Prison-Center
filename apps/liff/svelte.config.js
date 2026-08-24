import adapter from '@sveltejs/adapter-static'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/**
 * SPA mode. LIFF must boot client-side (`liff.init` needs the LINE SDK before
 * anything renders), SSR buys nothing inside a LINE webview, and a static
 * build deploys as plain files behind Caddy.
 *
 * @type {import('@sveltejs/kit').Config}
 */
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ fallback: 'index.html', strict: false }),
    typescript: {
      config(cfg) {
        cfg.include.push('../vite.config.ts')
        return cfg
      }
    }
  }
}
