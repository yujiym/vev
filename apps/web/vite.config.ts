// SPDX-License-Identifier: AGPL-3.0-or-later
import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vite-plus'

// Development only: the SPA runs on 5173 and /api goes to the Worker on 8787
// (`pnpm dev` starts both). In local mode and in production there is no proxy —
// the Worker serves this build from its assets binding on one origin (§15.3).
export default defineConfig({
  plugins: [sveltekit()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': { changeOrigin: true, target: 'http://127.0.0.1:8787' } },
    strictPort: true,
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
