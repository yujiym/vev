// SPDX-License-Identifier: AGPL-3.0-or-later
import { createRequire } from 'node:module'
import path from 'node:path'

import { voidSvelte } from '@void/svelte/plugin'
import { defineConfig } from 'vite-plus'
import { voidPlugin } from 'void'

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
// works because `hydra-synth` is a direct dependency of this package — pnpm's
// strict linking would not resolve it from `node_modules` otherwise.
const require = createRequire(import.meta.url)
const hydraSynthDist = path.join(path.dirname(require.resolve('hydra-synth')), '..', 'dist', 'hydra-synth.js')

export default defineConfig({
  // Every component is written in runes mode; a stray legacy-syntax component should fail, not silently compile.
  plugins: [voidPlugin(), voidSvelte({ svelte: { compilerOptions: { runes: true } } })],
  preview: { host: '127.0.0.1', port: 8787, strictPort: true },
  resolve: { alias: { 'hydra-synth': hydraSynthDist } },
  server: { host: '127.0.0.1', port: 8787, strictPort: true },
})
