# AGENTS.md

Guidance for AI coding agents working in this repository.

## Design reference

[docs/system-design.md](docs/system-design.md) is the canonical design of vev. Before implementing a milestone (§18), read the sections it depends on, and record any question the design does not answer in §17 of that document rather than deciding it silently in code.

The design describes software that does not exist yet: treat every section as intent, and the repository as the authority on what is built. Keep `docs/system-design.md` current when a decision changes the design — the root name `DESIGN.md` is reserved for design principles, so this document stays under `docs/`.

Decisions that shaped the code live in [docs/adr/](docs/adr/README.md): read the relevant ADR before revisiting a toolchain, structure or dependency choice, and add a new ADR rather than editing a past one.

How to run the repository, and the gotchas that only surface when you do, live in [docs/runbook.md](docs/runbook.md). Add to it when you find one; that is where an operational finding survives after its plan's working files are deleted.

`.svelte` templates sit outside the type and lint gate (`pnpm check`): oxlint reaches a component's `<script>` block with syntactic rules only, and `svelte-check` — the tool that would type-check templates — cannot run against this repository's TypeScript 7 (see [ADR 0001](docs/adr/0001-vite-plus-toolchain.md)). Keep components thin as a consequence: props in, markup out, logic and types in `.ts` modules the gate can actually check.

## Working files

An in-flight plan keeps its working files under `.superpowers/` — the plan, its progress ledger, briefs, reports and review packages. They are scratch for work in progress: when the work lands, `.superpowers/` is deleted and anything worth keeping has already moved into `docs/` (a decision becomes an ADR, an operational finding becomes a line in the runbook, a design change edits the design document). The root `vite.config.ts` excludes `.superpowers/**` from formatting because plan files carry indented code fragments whose indentation is the instruction.

## Toolchain

Vite+ (`vp`) drives tests, lint (oxlint) and format (oxfmt) from the root `vite.config.ts`, which holds the whole lint and fmt policy; read its header before changing a rule. Package-level `vite.config.ts` files configure that package's dev server, build and test environment.

- Entry points: `pnpm check` (typecheck + lint + fmt), `pnpm test`, `pnpm dev` (development, two processes), `pnpm live` (the built SPA served by the local Worker — how vev runs at a venue, §15.3).
- Install with `pnpm install --frozen-lockfile`; pnpm provisions Node itself.
- Keep lint strict. Suppress a rule only at the narrowest applicable line, with the reason: `// oxlint-disable-next-line <rule> -- <why>`.
- `vite-plus`, `oxlint`, `oxfmt` and the `vite@*` override in `pnpm-workspace.yaml` move together; that file's comments say why.

## Repository status

M0 (§18) is built: `apps/api` (Hono Worker; owns the D1/assets bindings and serves `apps/web`'s build as static assets), `apps/web` (SvelteKit SPA, `adapter-static`), and `packages/shared` (Valibot API schemas) all exist and are populated.

The rest of §4.1's layout is still a target, not a scaffold to assume: `packages/engines`, `packages/ingest`, `packages/decision`, and `services/decision-server` do not exist yet.

## Language

Write code, comments, documentation, specifications, and plans in English. Japanese belongs in `*.ja.md` mirrors, updated in the same change as the English original.

## Licensing

These rules apply from the first source file, because they are hard to retrofit:

- Every `package.json` carries `"license": "AGPL-3.0-or-later"`.
- Every authored file whose format supports comments starts with `// SPDX-License-Identifier: AGPL-3.0-or-later` (or the comment syntax of its language), excluding the JSON family (`.json`, `.jsonc`) — `package.json` carries the `license` field instead, `tsconfig.json` and friends stay parseable by strict `JSON.parse`-based tooling, and the repository-wide `LICENSE` file covers them.
- Add only dependencies under licenses compatible with AGPL-3.0 (MIT, BSD, Apache-2.0, ISC, MPL-2.0, LGPL, GPL-3.0, AGPL-3.0). GPL-2.0-only and unknown licenses do not qualify.
- Clips are content, not vev's code: `license`, `commercialOk`, `author`, `sourceUrl`, and `modified` are mandatory on every clip, and the original license header is preserved in `originalCode`. See §14.

## Commits

- Write commit messages in English.
- Sign off every commit (`git commit -s`): the project uses the Developer Certificate of Origin, checked in CI.
- Keep unrelated work in separate commits, and land a design-document correction separately from the code it describes.
