<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0008: Cloudflare Vite plugin for the API

Supersedes ADR 0006's choice of Wrangler as cf's bundler. Keep ADR 0002's separate SvelteKit SPA and Hono Worker packages: the plugin belongs only to `apps/api` and consumes the already-built SPA as Vite's `publicDir`.

Use `@cloudflare/vite-plugin@2.0.0-beta.sha-ad79608dd` with `cf@1.0.0-beta.5`. cf rejects the stable v1 plugin for its local runtime and build output. The v2 beta has no Wrangler dependency; remove the direct Wrangler dependency and `wrangler.config.ts`. The Worker test pool still brings Wrangler transitively, so this is not complete removal from the dependency graph. Accept that test dependency until the pool supports its replacement.

`cloudflare.config.ts` remains the source of Worker bindings, assets routing and deployment settings. `vite.config.ts` owns bundling, the public assets directory, the fixed local port and `.wrangler/state` persistence. Move the isolated Worker test configuration to `vitest.config.ts`, preserving its cloud-mode Access checks. Disable generated Worker types because the repository already owns its binding types.

Vite reserves `local` as an environment-file suffix and rejects it as a mode name. Use `development` for local commands and configuration selection while keeping `VEV_MODE=local` inside the Worker. Preview and default deployment bindings remain isolated from local resources. Preserve the local D1 UUID and storage directory from ADR 0007, including its Miniflare watcher patch.

Development serves the placeholder from `dev-assets` on port 8787 while SvelteKit runs separately. Live mode serves the built SPA from `apps/web/build`; the existing smoke check must still see the exact built HTML on unmatched paths and a real 404 for unknown API routes. This does not settle M11's offline, non-watching venue host process.
