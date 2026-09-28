// SPDX-License-Identifier: AGPL-3.0-or-later
import path from 'node:path'

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// Since its 0.2x line (the one compatible with the Vitest 4 that Vite+ bundles)
// the pool is a Vite plugin — `cloudflareTest(...)` — rather than the old
// `defineWorkersConfig` + `test.poolOptions.workers` shape.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
        },
      },
      wrangler: { configPath: './wrangler.jsonc', environment: 'local' },
    })),
  ],
  test: { include: ['test/**/*.test.ts', 'src/**/*.test.ts'], setupFiles: ['./test/setup.ts'] },
})
