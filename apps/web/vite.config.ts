// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process'

import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vite-plus'

// Development only: the SPA runs on 5173 and /api goes to the Worker on 8787
// (`pnpm dev` starts both). In local mode and in production there is no proxy —
// the Worker serves this build from its assets binding on one origin (§15.3).

// AGPL §13 source offer (§14.1): PUBLIC_GIT_COMMIT must name the exact commit
// this build serves. `git rev-parse` fails in a tarball build with no `.git`
// (or when `git` itself is unavailable), so that falls back to `dev` — the
// same value Source.svelte already treats as "no commit known". A shell
// override (e.g. a release pipeline exporting PUBLIC_GIT_COMMIT itself) wins
// over both.
process.env.PUBLIC_GIT_COMMIT ??= (() => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: import.meta.dirname,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
  } catch {
    return 'dev'
  }
})()

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
