import adapter from '@sveltejs/adapter-static'
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte'

/**
 * SPA mode. The dashboard sits behind auth and an IP allowlist — no SEO, no
 * SSR, and a static build that Caddy serves as plain files.
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
