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
| `pnpm deploy:preview` | Builds the SPA, then uploads a new Worker Version to the `preview` environment (a real screen, not localhost) and prints a version-specific preview URL. Does not promote: the stable `vev-preview.<subdomain>.workers.dev` URL still serves whatever the one-time bootstrap deploy set (see the gotcha below); nobody has run `wrangler versions deploy` to move it since. |
| `pnpm --filter api run migrate:preview` | Applies D1 migrations to `vev-preview`, the preview environment's own remote database — never the `vev` production database. |

## Gotchas

- **During `pnpm dev`, port 8787 serves a placeholder, not the app.** The Worker needs an assets directory to start, and in development the real SPA is Vite's on 5173. `apps/api/dev-assets/index.html` says so on the page itself. Only `pnpm live` serves the real build from the Worker.
- **After a change to the `miniflare` / `workerd` overrides in `pnpm-workspace.yaml`, reinstall from scratch.** A stale symlink survives in an already-installed `node_modules`; neither `pnpm install` nor `pnpm install --force` clears it. `rm -rf node_modules && pnpm install` does. A fresh clone and CI are unaffected — the lockfile is correct.
- **`pnpm migrate:local` does not pass `--env local`.** It works because the top-level and `env.local` `d1_databases` blocks are identical. If they ever diverge, this command will silently migrate the wrong database.
- **Name the next migration**: `drizzle-kit generate --name <name>`. Without it drizzle-kit invents a name and the file has to be renamed and its entry in `migrations/meta/_journal.json` corrected by hand.
- **`TEST_MIGRATIONS` is a required member of the global `Cloudflare.Env`** (`apps/api/test/env.d.ts`), and `apps/api/tsconfig.json` compiles `src` and `test` as one program. Inert while production code reads bindings through Hono's typed `Env`; revisit if any code adopts `import { env } from 'cloudflare:workers'`.
- **`.svelte` templates are outside the gate.** `pnpm check` reaches a component's `<script>` block with syntactic rules only — no template linting, no type-aware rules — because `svelte-check` cannot run against TypeScript 7 (see [ADR 0001](./adr/0001-vite-plus-toolchain.md)). Keep logic in `.ts` and components thin.
- **Wrangler's named environments inherit `assets` but not `vars` or `d1_databases`**, so those two are repeated under `env.local` (and `env.preview`) in `apps/api/wrangler.jsonc`. Verified by removing each block and watching the binding disappear.
- **The preview deployment has no Cloudflare Access in front of it, on purpose, for now.** Per spec §13, a reachable deployment is acceptable when its hostname is covered by an Access policy _or_ when it carries no owner routes. M1 has no owner routes — no `/studio` behind auth yet, only the output route, the debug panel and `/api/health` — so the preview ships unprotected: anyone with the link can use it, whether that link is the stable `vev-preview.<subdomain>.workers.dev` URL or any per-version URL `versions upload` prints. This is a deliberate, time-limited decision, not an oversight, and it must not be extended past M1: Access has to land with the milestone that adds owner routes.
- **The Worker's `env.preview` never points at the `vev` (production) D1 database** — it has its own `vev-preview` database (`bcee626b-7dbd-4456-8fb9-a708583e6e1d`), separate from `vev` (`6554a370-8884-4cbb-9f87-9d891a34ddcd`, reserved for M12). This is the whole reason the preview has its own `d1_databases` block instead of sharing the top-level one.
- **The Worker script has to exist before `versions upload` will work.** The very first deploy to a new named environment must be a real `wrangler deploy --env preview` (or `versions deploy`) to create the script and its `workers.dev` route; only after that does `wrangler versions upload --env preview` (what `deploy:preview` runs) succeed. This is a one-time bootstrap per environment, not something the repeatable `deploy:preview` script needs to know about.
- **`versions upload`'s preview URL is per-version**, e.g. `https://<version-id>-vev-preview.<subdomain>.workers.dev` — a fresh one is printed on every `pnpm deploy:preview`, distinct from the environment's stable `https://vev-preview.<subdomain>.workers.dev` (which only moves when someone runs `wrangler versions deploy` or the bootstrap `wrangler deploy`).

- **The licence check only understands SPDX identifiers.** It compares each `license` field verbatim against an allow list of SPDX ids, so a package that spells its field loosely fails as unknown even when its licence is allowed. The first one vev meets is `hydra-synth`: the field reads `AGPL` where the `LICENSE` file is AGPL Version 3. Adding it in M1 fails `pnpm licenses:check` until `AGPL` is in the allow list in `scripts/check-licenses.mjs`, with that verification beside it. Add the exact string; do not loosen the comparison.

## Not wired yet

The preview environment (M1 task 6) is wired; production is M12's milestone. Before _that_ can work:

- `apps/api/wrangler.jsonc`'s top-level `database_id` (production, `vev`) is still a placeholder; `apps/api/drizzle.config.ts` has no `dbCredentials`, which `drizzle-kit push` and `studio` need.
- `apps/api`'s plain `deploy` script (production, unused by M1) still needs the SPA built first and `GIT_COMMIT` injected the same way `deploy:preview` does it — nobody has wired it because nothing runs it yet.
- `THIRD_PARTY_NOTICES.md` (§4.1, §14.1) does not exist.
- Cloudflare Access for owner routes (see the preview-has-no-Access gotcha above) — lands with the milestone that adds them.
