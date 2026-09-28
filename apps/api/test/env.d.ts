// SPDX-License-Identifier: AGPL-3.0-or-later
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
    // oxlint-disable-next-line typescript/no-empty-object-type, typescript/no-empty-interface -- declaration-merging pattern for augmenting the ambient Cloudflare.Env namespace; it has no members of its own by design
    interface Env extends WorkerEnv {}
  }
}
