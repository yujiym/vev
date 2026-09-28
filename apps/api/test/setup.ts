// SPDX-License-Identifier: AGPL-3.0-or-later
import { applyD1Migrations, env } from 'cloudflare:test'
import { beforeAll } from 'vitest'

// TEST_MIGRATIONS is bound in vite.config.ts from the migrations directory.
beforeAll(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
})
