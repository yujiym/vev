// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from 'vite-plus'
import { voidPlugin } from 'void'

export default defineConfig({
  plugins: [voidPlugin()],
  preview: { host: '127.0.0.1', port: 8787, strictPort: true },
  publicDir: process.env.VEV_ASSETS_DIRECTORY ?? '../web/build',
  server: { host: '127.0.0.1', port: 8787, strictPort: true },
})
