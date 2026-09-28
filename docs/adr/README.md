<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Architecture decision records

An ADR records a decision that shaped the code: the context that forced a choice, the alternatives weighed, and the consequences accepted. `docs/spec.md` stays the description of the design as it stands; these records exist to explain why it is that way.

ADRs are append-only. A decision that changes is recorded as a new ADR that supersedes the old one — never by rewriting a past record — so the history of what was tried and why stays intact.

## Index

- [0001 — Vite+ toolchain](0001-vite-plus-toolchain.md): lint, format, typecheck and test are driven by Vite+ (`vp`) on the 0.3 line, with the policy migrated from fuda-sh.
- [0002 — web and API as separate packages](0002-web-and-api-as-separate-packages.md): the SPA and the Worker are two packages, `apps/web` and `apps/api`, built into one deployable Worker rather than unified with `@cloudflare/vite-plugin`.
- [0003 — Valibot for validation](0003-valibot-for-validation.md): runtime validation uses Valibot rather than Zod, for tree-shaking and consistency with the sibling toolchain it was migrated from.
- [0004 — Playback state as a pure reducer](0004-playback-state-as-a-pure-reducer.md): all switch decisions live in a pure reducer with a wall-clock timestamp; the renderer only executes them — and, discovered in M1, that seam needs its own test, because a pure decision does not guarantee the renderer obeys it.
