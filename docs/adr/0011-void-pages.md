<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0011: Void Pages, in one package

Supersedes ADR 0002. Corrects the reasoning in ADR 0009 about why `apps/web` stayed a package of its own; the rest of ADR 0009 stands.

## Context

ADR 0009 put the API on Void and kept the SvelteKit SPA in a separate package, because Void selects framework mode for any package that depends on `@sveltejs/kit`. It named Void pages as the third option and did not try them, on the grounds that they meant rewriting the routes and that SSR adds nothing to a control window and an output window.

That reasoning ran two things together. Framework mode forces a second package only for as long as SvelteKit stays. The maintainer wanted one app on Void: one package, one dev process, one build. Void Pages (`@void/svelte`) gives that, and it does not require server rendering, because a page opts out of it.

## Decision

`apps/app` is the one package. It holds the pages, the Hono Worker, the queue consumer and the D1 migrations. `apps/web` and `apps/api` are gone, and so are `@sveltejs/kit`, `adapter-static` and `svelte.config.js`. The history is kept: `apps/api` was renamed to `apps/app`, and the web sources were moved into it, with `git mv`.

- **Every page sets `ssr = false`** in a `.server.ts` companion. Void then returns a client-mounted shell that embeds the page's props and the shared data, and the Worker renders no component. That keeps the rule §4 stated for SvelteKit ("no SSR") and keeps `hydra-synth` out of the Worker bundle: `dist/ssr` holds no `hydra-synth`, `regl`, `meyda` or `raf-loop`, and the Hydra chunk exists only in `dist/client`. The Vite alias for `hydra-synth`'s `dist/` build moved to `apps/app/vite.config.ts` with its comment.
- **Hono stays behind the middleware seam.** `middleware/01.server.ts` hands `/api/*` and `/media/*` to the unchanged Hono app and does nothing else. `queues/` and `db/` are as they were.
- **`pages/[...path]` replaces the SPA fallback.** Void has no app-level fallback for a path no page matches: `routing.notFound` governs only the asset layer, and the Worker runs first for every path. The catch-all renders a "Not found" view inside the layout, so a deep link or a reload on a path the app does not have still loads the app. A path that names a file (`/assets/missing.js`, `/favicon.ico`) throws `HTTPException(404)` from the same loader, so a missing asset is never answered with HTML. An unknown `/api/*` path still gets Hono's own 404.
- **The AGPL source link travels as shared page data.** `void.config.ts` resolves the Worker's `GIT_COMMIT` (the shell's `GIT_COMMIT`, else `git rev-parse --short HEAD`, else `dev`), `deploy-targets.ts` keeps `SOURCE_URL`, and `middleware/02.shared.ts` returns both through `c.set('shared', …)` for the layout's `useShared()`. `/api/health` and the link now read one value. Before, `/api/health` reported `dev` on every local build, because only the web package ran `git rev-parse`. `VITE_*` values were not used: Void ignores them from `.env` at build time and would have needed a second source for the commit.
- **Two Vitest projects in one package.** `worker` runs the Hono app and routes in workerd; `client` runs the browser logic under `client/` in Node. `vitest.config.ts` defines both and `vite.config.ts` is not loaded for tests.
- **Two tsconfigs, plus one for scripts.** The Worker's `tsconfig.json` loads `@cloudflare/workers-types` and has no DOM lib; `client/tsconfig.json` has the DOM lib and no Worker types. Merging them is the conflict ADR 0002 avoided with a package boundary; a directory boundary does the same job here, and `vp check` follows it.

## Alternatives

- **SvelteKit in framework mode** stays the fallback if Void Pages fails. It needs `@sveltejs/adapter-cloudflare`, whose peer is `wrangler` (ADR 0009), and its `vp preview` runs in Node, not workerd. Nothing in the move found a reason to use it.
- **Keeping two packages** works, and ADR 0002's costs are real: two dev processes with a proxy, and a build order that `pnpm live` and the deploy path had to respect. It was not the maintainer's goal.

## Evidence

All of it from a real `pnpm live` (`vp preview`, workerd) unless noted.

- `scripts/smoke-live.sh` passes. It no longer compares a deep path against a built `index.html`, which no longer exists; it checks the page shell, the catch-all, that the client script the shell names loads, the 404 for a missing file and an unknown API path, and that the page's shared commit equals `/api/health`'s.
- All five browser drivers (`library`, `editor`, `playback`, `live`, `stills`) pass with their assertions unchanged.
- `/output` and `/studio` request only same-origin assets. A reload of `/output` restores its picture through the `hello` handshake.
- `/studio/tracks/[id]` was driven from a list link and by a same-route history change from one track to another; `useParams()` followed the change both times, so it is used as is. fuda-sh found it going stale in `@void/solid` 1.4.0, which is a different adapter.
- `VEV_TARGET=preview` and `production` build with `preview_urls` and `workers_dev` false, and the bindings, queue and routes match the previous package's. `void deploy` was not run.
- `pnpm test` runs 588 tests. The base commit also ran 588: 218 in `apps/api` and 174 in `apps/web`, which are the 392 in `apps/app`, plus 196 in `packages/*`.

## Consequences

- `pnpm dev` is one process on `127.0.0.1:8787` for the pages and the API. `pnpm live` is one `vp build`. `void deploy` builds everything itself, so ADR 0002's build-order cost is gone.
- Local state moves from `apps/api/.void/` to `apps/app/.void/`. `docs/runbook.md` says how to carry it over.
- A page's HTML is no longer one `index.html` for every path. It carries its own route's data and a hashed script URL, so offline reload of a deployed page needs a shell cached per route. Recorded in §17.
- A loader cannot set the status of a client-mounted shell, so the not-found view answers 200, as the SPA fallback did. Recorded in §17.
- `@void/svelte@1.5.0` was published 2026-11-02, inside `minimumReleaseAge`. It is excluded in `pnpm-workspace.yaml`, exactly, with the maintainer's approval of the Void 1.5 series.
- `.svelte` files remain outside the type and lint gate (ADR 0001). Pages stay thin, with logic in `client/*.ts`.
