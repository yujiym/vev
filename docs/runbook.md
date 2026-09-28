<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Runbook

How to run vev locally and what bites. The design lives in [spec.md](./spec.md); decisions live in [adr/](./adr/README.md). This file is only what someone needs to operate the repository, and every entry was established by running it.

## Commands

| Command | What it does |
| --- | --- |
| `pnpm install --frozen-lockfile` | Installs; pnpm provisions Node itself. Runs `apps/web`'s `svelte-kit sync` through its `prepare` script. |
| `pnpm dev` | Development: the SPA on `127.0.0.1:5173` with `/api` proxied to the Worker on `127.0.0.1:8787`. Applies local D1 migrations first. |
| `pnpm live` | Local mode (§15.3): builds the SPA, applies local D1 migrations, and serves both from the Worker on `127.0.0.1:8787` — the same shape that deploys. |
| `pnpm check` | Typecheck, lint (oxlint) and format (oxfmt). |
| `pnpm test` | Every package's tests; `apps/api`'s run inside workerd. |
| `pnpm licenses:check` | Fails on a production dependency whose licence is not AGPL-3.0 compatible (§14.1). |
| `bash scripts/smoke-live.sh` | Starts `pnpm live` and asserts the single-origin contract: `/api/health` JSON, SPA fallback on an unmatched path, `404` on an unknown API route. CI runs this. |

## Gotchas

- **During `pnpm dev`, port 8787 serves a placeholder, not the app.** The Worker needs an assets directory to start, and in development the real SPA is Vite's on 5173. `apps/api/dev-assets/index.html` says so on the page itself. Only `pnpm live` serves the real build from the Worker.
- **After a change to the `miniflare` / `workerd` overrides in `pnpm-workspace.yaml`, reinstall from scratch.** A stale symlink survives in an already-installed `node_modules`; neither `pnpm install` nor `pnpm install --force` clears it. `rm -rf node_modules && pnpm install` does. A fresh clone and CI are unaffected — the lockfile is correct.
- **`pnpm migrate:local` does not pass `--env local`.** It works because the top-level and `env.local` `d1_databases` blocks are identical. If they ever diverge, this command will silently migrate the wrong database.
- **Name the next migration**: `drizzle-kit generate --name <name>`. Without it drizzle-kit invents a name and the file has to be renamed and its entry in `migrations/meta/_journal.json` corrected by hand.
- **`TEST_MIGRATIONS` is a required member of the global `Cloudflare.Env`** (`apps/api/test/env.d.ts`), and `apps/api/tsconfig.json` compiles `src` and `test` as one program. Inert while production code reads bindings through Hono's typed `Env`; revisit if any code adopts `import { env } from 'cloudflare:workers'`.
- **`.svelte` templates are outside the gate.** `pnpm check` reaches a component's `<script>` block with syntactic rules only — no template linting, no type-aware rules — because `svelte-check` cannot run against TypeScript 7 (see [ADR 0001](./adr/0001-vite-plus-toolchain.md)). Keep logic in `.ts` and components thin.
- **Wrangler's named environments inherit `assets` but not `vars` or `d1_databases`**, so those two are repeated under `env.local` in `apps/api/wrangler.jsonc`. Verified by removing each block and watching the binding disappear.

## Not wired yet

Deployment is M12's milestone. Before it can work:

- `apps/api`'s `deploy` script needs the SPA built first — `wrangler deploy` alone fails with a missing assets directory.
- `apps/api/wrangler.jsonc`'s `database_id` is a placeholder; `apps/api/drizzle.config.ts` has no `dbCredentials`, which `drizzle-kit push` and `studio` need.
- The Worker's `GIT_COMMIT` var is still the literal `dev`; only the web build injects a real commit today. A deploy must set it, or the footer link and the API will disagree.
- `THIRD_PARTY_NOTICES.md` (§4.1, §14.1) does not exist.
