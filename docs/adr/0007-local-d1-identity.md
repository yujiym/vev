<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0007: Replace the local D1 identity

This supersedes ADR 0006's local D1 compatibility exception. The user authorized replacing the local database so all D1 commands can use `cf`. The nil UUID fails `cf` migration validation. A dedicated valid UUID, `9b91c754-01f5-4399-98a7-bc8b5c9e65e8`, works with `cf d1 migrations` and `cf d1 raw --local`. The `query` endpoint remains unsupported locally in beta.5.

Preserve `.wrangler/state` and the R2 identity. Back up the old SQLite database and copy it to the new identity with SQLite's backup API while servers are stopped; verify dump equality and integrity before startup. Keep the original file. Fresh clones create the new database through migrations. The runbook records the migration procedure.

Local migrations and browser fixtures now use `cf`, and `wrangler.local.jsonc` is removed. Wrangler remains the internal bundler selected in ADR 0006.

The pinned Miniflare leaks a persistent dev-registry file watcher after local CLI cleanup. Async-hook tracing identified an active `FSEVENTWRAP` after `cf` returned; disabling telemetry and using a fresh registry did not fix it. A two-line pnpm patch sets that watcher to `persistent: false`. Registry notifications still work while the runtime is active, but discovery alone no longer holds a completed CLI process open. Check fresh migration, repeated migration, SQL writes while a Worker is running, and the live smoke test when updating this dependency.
