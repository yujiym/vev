<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0009: Void as the Worker's runtime and deploy tool

Supersedes ADR 0006 and ADR 0008. ADR 0007's local D1 UUID stays, under a new persistence directory. ADR 0002's two packages stay, for the reason below.

## Context

The goal was one app: the SPA and the API built and served together by [Void](https://void.cloud). Three shapes were available. Void's framework mode keeps SvelteKit in one package. A native Void Worker serves the SPA's build as static assets. Void pages replace SvelteKit outright.

## Decision

Use a native Void Worker in `apps/api`, on Void 1.5.0, serving `apps/web`'s `adapter-static` build through `publicDir`.

Framework mode was tried first and rejected. It requires `@sveltejs/adapter-cloudflare`, whose required peer is `wrangler`, and the maintainer ruled out Wrangler in favour of `void` and `cf`. It also offers no way to serve the built Worker in workerd: `vp preview` under it is SvelteKit's preview server in Node, which §15.3 forbids for a show. Void selects framework mode whenever a package's own `package.json` depends on `@sveltejs/kit`, and `inference.appType: 'void'` does not override that, so SvelteKit cannot share a package with a native Void Worker. That is the reason `apps/web` stays separate.

Void pages were not tried. They mean rewriting all eight routes, and SSR adds nothing to a control window and an output window that only run in a browser.

## Consequences

- `pnpm live` is `vp build`, `void db migrate`, `vp preview`, which runs the built Worker in workerd on `127.0.0.1:8787`.
- `middleware/01.server.ts` is the seam: `/api/*` and `/media/*` go to the unchanged Hono app. It also owns the SPA fallback. `routing.notFound` must stay `none`, because Void asks the assets again for a route's 404, and an asset-layer fallback answers an unknown `/api` path with `200 index.html`. `scripts/smoke-live.sh` fails if that returns.
- `pnpm dev` still runs two processes, with `/api` proxied from 5173 to 8787.
- The queue consumer is `queues/ingest.ts`, bound as `QUEUE_INGEST`. Void creates a local queue that delivers to the consumer, so local mode ignores the binding to keep §15.3's "no queue at a venue". Void names the Cloudflare queue `<worker>-ingest`, not the old `vev-ingest-preview`; the first deploy has to drain and remove the old consumer.
- `VEV_TARGET` selects `local`, `preview` or `production` in `void.config.ts`. Deploying a target with `void deploy` has not been run. Linking the existing `vev-preview` Worker is the first step of the next deploy.
- Local data lives in `apps/api/.void/`. Data in the old `.wrangler/state` does not carry over. Run `pnpm migrate:local` on a checkout that has none.
- `wrangler` is not a dependency of this repository, but `@cloudflare/vitest-plugin` still brings it transitively for the Worker test pool.
- Void 1.5.0 was younger than `minimumReleaseAge` when adopted. Its exact versions are excluded in `pnpm-workspace.yaml`, with the maintainer's approval, and those lines can go once a later Void is adopted.
