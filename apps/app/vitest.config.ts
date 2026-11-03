// SPDX-License-Identifier: AGPL-3.0-or-later
import path from 'node:path'

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

// Since its 0.2x line (the one compatible with the Vitest 4 that Vite+ bundles)
// the pool is a Vite plugin — `cloudflareTest(...)` — rather than the old
// `defineWorkersConfig` + `test.poolOptions.workers` shape.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: 'src/index.ts',
      miniflare: {
        bindings: {
          ACCESS_AUD: 'unused-in-tests',
          ACCESS_TEAM_DOMAIN: 'unused-in-tests',
          // Different from local mode so health tests detect hard-coded values.
          GIT_COMMIT: 'test-fixture-commit',
          SOURCE_URL: 'https://github.com/yujiym/vev',
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'db/migrations')),
          VEV_MODE: 'cloud',
        },
        compatibilityDate: '2026-09-01',
        compatibilityFlags: ['nodejs_compat'],
        d1Databases: ['DB'],
        r2Buckets: ['MEDIA'],
      },
    })),
  ],
  test: { include: ['test/**/*.test.ts', 'src/**/*.test.ts'], setupFiles: ['./test/setup.ts'] },
})
