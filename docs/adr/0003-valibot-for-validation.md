<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0003: Valibot for validation

## Context

`docs/spec.md` §4 originally named Zod for runtime input validation (request bodies, environment values, clip and track schemas). Both Zod and Valibot have equivalent Hono and Drizzle integrations available — `@hono/valibot-validator@0.6.1` and `drizzle-valibot@0.4.2`, both MIT-licensed — so the choice between them is not about a capability either library lacks.

## Decision

Valibot, with `import * as v from 'valibot'` as the house style throughout `packages/shared` and `apps/api`. §4 of `docs/spec.md` was updated to name Valibot in place of Zod.

## Consequences

- Valibot's schemas tree-shake per validator used, rather than pulling in one monolithic runtime. This matters for `apps/web`: the SPA's Service Worker caches it for offline use at a venue (§15.3), so every byte in the cached bundle is a byte that must be fetched and stored before a show, and shipping only the validators actually referenced keeps that bundle to what is used, unlike a validation library that ships as one monolithic runtime.
- The vocabulary matches fuda-sh, the sibling repository this toolchain (ADR 0001) was migrated from — a contributor or future agent moving between the two projects reads the same validation idiom in both.
- The cost: Zod is the better-known library of the two, so an external contributor — §14.1 explicitly invites them — meets a less familiar API on their first schema change. `CONTRIBUTING.md` links Valibot's own documentation for exactly this reason, in the section on the validation library.
