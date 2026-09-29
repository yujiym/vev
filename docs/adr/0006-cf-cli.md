<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0006: cf as the Cloudflare CLI

## Context

Cloudflare introduced `cf` with TypeScript configuration and a migration tool. The repository uses separate SPA and Worker packages, Wrangler's bundler, persistent local D1/R2 state, and preview uploads that do not promote traffic. The globally installed CLI is `1.0.0-beta.5`.

## Decision

Pin that version in `apps/api` for reproducible package scripts and CI. Use `cloudflare.config.ts` for Worker configuration and `wrangler.config.ts` for bundler settings. Retain Wrangler as the internal bundler, the migration tool's default for this repository. ADR 0002's package boundaries remain unchanged.

Use `cf dev`, `cf deploy`, `cf workers versions create`, and `cf d1 migrations apply` for remote migrations. Preserve preview resource IDs, disabled workers.dev endpoints, queue settings and the custom domain. Pass the commit through `GIT_COMMIT`. Keep `.wrangler/state` for local development.

Retain a minimal `wrangler.local.jsonc` for local D1 migrations and fixture queries. The beta rejects the existing nil UUID in migration commands, and its local query endpoint failed with the pinned runtime. Replacing the database identity would hide existing data. Full removal of this compatibility path waits for support or an explicit data migration.

## Consequences

The global CLI is sufficient for interactive use, but package scripts resolve the pinned dependency. The Worker test pool reads the TypeScript configuration directly and creates isolated Miniflare storage. Cloud and local bindings are selected explicitly rather than relying on Wrangler environment inheritance.

Wrangler remains a dependency for bundling and the local D1 exception. This is a CLI migration, not a switch to the Cloudflare Vite plugin. No deployment or remote database change is required to migrate the repository.

## Source

[Cloudflare's cf launch and migration guidance](https://blog.cloudflare.com/cloudflare-cf-cli-launch/), checked against the installed beta's help and `cf migrate` output on 2026-09-29.
