<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0002: `apps/web` and `apps/api` as separate packages

## Context

vev deploys as one Worker that serves the SPA from its own assets binding (§3 of `docs/spec.md`). That single deployable artifact can be built from two packages — a SvelteKit SPA and a Hono Worker, composed at deploy time — or from one unified package using `@cloudflare/vite-plugin`, which builds a SvelteKit app and a Worker together from a single Vite config.

## Decision

Two packages, `apps/web` and `apps/api`, as §4.1 describes: `apps/web` is the SvelteKit SPA (`adapter-static`, SPA mode, no SSR), `apps/api` is the Hono Worker, and `apps/api`'s `wrangler.jsonc` serves `apps/web`'s build output as its `assets` binding.

## Consequences

- The `workerd` test environment stays isolated to `apps/api`, and each package's test environment falls out of the package boundary instead of needing per-file overrides inside one package: `apps/web`'s tests run under a plain `node` environment (`apps/web/vite.config.ts`'s `test.environment: 'node'`), `apps/api`'s tests run under `@cloudflare/vitest-pool-workers` inside a real `workerd`. Neither package's `tsconfig.json` or `vite.config.ts` needs to reconcile `@cloudflare/workers-types` against a browser-shaped environment.
- §15.3's rule that every route works with `AI`, `VECTORIZE` and the queue absent is enforced by `apps/api`'s own `Env` type (`apps/api/src/env.ts`) — a binding that isn't declared there simply isn't available to a route, so the constraint is structural rather than a lint rule to remember.
- Stacking `@cloudflare/vite-plugin` on top of the SvelteKit-under-Vite+ integration (already a novel combination — see ADR 0001) was avoided.
- The cost, paid in Tasks 5–6: two dev processes (`apps/web`'s Vite dev server and `apps/api`'s `wrangler dev`) with a `/api` proxy configured in `apps/web/vite.config.ts` for local development; the shared API contract (request/response schemas) travels through `@vev/shared` rather than being inferred automatically across a single build graph; and a build order — `apps/web` built before `apps/api` is run under `wrangler dev`/`live` or deployed — that `pnpm live` and the eventual deploy path must respect. `package.json`'s `live` script (`pnpm --filter web run build && pnpm --filter api run live`) encodes this order directly; `pnpm dev` needs no such order, since it runs both dev servers live and proxies between them.
