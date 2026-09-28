// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import path from 'node:path'

import { sveltekit } from '@sveltejs/kit/vite'
import { defineConfig } from 'vite-plus'

// hydra-synth's ESM entry (src/) pulls in CJS deps (regl, meyda, raf-loop) whose
// Vite-optimized bundle references bare `global`, which does not exist under
// Vite's dev server ("global is not defined"). The package's own `dist/` build
// (browserify, its documented `require` build target) wraps each module so
// `global` resolves locally and interops cleanly. Verified in M1 Task 3's spike
// (see task-3-report.md) — reproduced by opening a probe route in a headless
// browser and confirming non-zero rendered pixels once this alias was in place.
//
// `require.resolve('hydra-synth')` resolves the package's `"."` export (its
// `exports` map blocks any bare subpath, including `dist/...`), so the walk to
// `dist/hydra-synth.js` happens via a real filesystem path instead. This only
// works because `hydra-synth` is a direct dependency of this app (pnpm's strict
// linking would not resolve it from `node_modules` otherwise) — see this app's
// `package.json`.
const require = createRequire(import.meta.url)
const hydraSynthDist = path.join(path.dirname(require.resolve('hydra-synth')), '..', 'dist', 'hydra-synth.js')

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
  resolve: { alias: { 'hydra-synth': hydraSynthDist } },
  server: {
    host: '127.0.0.1',
    port: 5173,
    proxy: { '/api': { changeOrigin: true, target: 'http://127.0.0.1:8787' } },
    strictPort: true,
  },
  test: { environment: 'node', include: ['src/**/*.test.ts'] },
})
