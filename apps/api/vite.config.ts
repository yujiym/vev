// SPDX-License-Identifier: AGPL-3.0-or-later
import path from 'node:path'

import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

import cloudflareConfig from './cloudflare.config'

const { worker } = cloudflareConfig({ isPreview: false, mode: 'local' })

// Since its 0.2x line (the one compatible with the Vitest 4 that Vite+ bundles)
// the pool is a Vite plugin — `cloudflareTest(...)` — rather than the old
// `defineWorkersConfig` + `test.poolOptions.workers` shape.
export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      main: worker.entrypoint,
      miniflare: {
        bindings: {
          ACCESS_AUD: worker.env.ACCESS_AUD.value,
          ACCESS_TEAM_DOMAIN: worker.env.ACCESS_TEAM_DOMAIN.value,
          // Different from local mode so health tests detect hard-coded values.
          GIT_COMMIT: 'test-fixture-commit',
          SOURCE_URL: worker.env.SOURCE_URL.value,
          TEST_MIGRATIONS: await readD1Migrations(path.join(import.meta.dirname, 'migrations')),
          VEV_MODE: 'cloud',
        },
        compatibilityDate: worker.compatibilityDate,
        compatibilityFlags: worker.compatibilityFlags,
        d1Databases: ['DB'],
        r2Buckets: ['MEDIA'],
      },
    })),
  ],
  test: { include: ['test/**/*.test.ts', 'src/**/*.test.ts'], setupFiles: ['./test/setup.ts'] },
})
