import { defineConfig, loadEnv } from 'vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')

  return {
    plugins: [
      tailwindcss(),
      // Inject hCaptcha site key into index.html at build time so it never
      // appears hardcoded in source. The secret key stays server-side only.
      {
        name: 'inject-hcaptcha-sitekey',
        transformIndexHtml(html) {
          const sitekey = env.VITE_HCAPTCHA_SITEKEY || ''
          return html.replace('__VITE_HCAPTCHA_SITEKEY__', sitekey)
        },
      },
    ],
  }
})
