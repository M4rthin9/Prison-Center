import { sveltekit } from '@sveltejs/kit/vite'
import tailwindcss from '@tailwindcss/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [tailwindcss(), sveltekit()],
  server: {
    port: 5173,
    // Same-origin in dev, so the httpOnly refresh cookie behaves exactly as it
    // will in production behind Caddy — no CORS special cases to debug.
    proxy: {
      '/api': { target: 'http://localhost:8787', changeOrigin: false },
      '/files': { target: 'http://localhost:8787', changeOrigin: false }
    }
  }
})
