// SPDX-License-Identifier: AGPL-3.0-or-later
import { cloudflare } from '@cloudflare/vite-plugin'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  plugins: [
    cloudflare({
      persistState: { path: '.wrangler/state' },
      types: { generate: false },
    }),
  ],
  publicDir: process.env.VEV_ASSETS_DIRECTORY ?? '../web/build',
  server: { host: '127.0.0.1', port: 8787, strictPort: true },
})
