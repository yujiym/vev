// SPDX-License-Identifier: AGPL-3.0-or-later
import type { D1Migration } from 'cloudflare:test'

import type { Env as WorkerEnv } from '../src/env.ts'

// Older @cloudflare/vitest-pool-workers releases exposed a `ProvidedEnv`
// interface on `cloudflare:test` for this augmentation. 0.22.0 types
// `cloudflare:test`'s `env` as `Cloudflare.Env` instead — the ambient
// namespace `@cloudflare/workers-types` declares for `wrangler types` to
// populate — so this augments that namespace instead; it is the same pattern
// `wrangler types` itself generates.
// `declare global` is required here: this file has a top-level `import`, which
// makes it a module, and a module-scoped `declare namespace` would not merge
// with the ambient global `Cloudflare` namespace `@cloudflare/workers-types`
// declares.
declare global {
  namespace Cloudflare {
    interface Env extends WorkerEnv {
      /** Bound in vite.config.ts from the migrations directory; not a runtime binding. */
      TEST_MIGRATIONS: D1Migration[]
    }
  }
}
