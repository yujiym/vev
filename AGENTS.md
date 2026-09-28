# AGENTS.md

Guidance for AI coding agents working in this repository.

## Design reference

[docs/system-design.md](docs/system-design.md) is the canonical design of vev. Before implementing a milestone (§18), read the sections it depends on, and record any question the design does not answer in §17 of that document rather than deciding it silently in code.

The design describes software that does not exist yet: treat every section as intent, and the repository as the authority on what is built. Keep `docs/system-design.md` current when a decision changes the design — the root name `DESIGN.md` is reserved for design principles, so this document stays under `docs/`.

## Toolchain

Vite+ (`vp`) drives tests, lint (oxlint) and format (oxfmt) from the root `vite.config.ts`, which holds the whole lint and fmt policy; read its header before changing a rule. Package-level `vite.config.ts` files configure that package's dev server, build and test environment.

- Entry points: `pnpm check` (typecheck + lint + fmt), `pnpm test`, `pnpm dev` (development, two processes), `pnpm live` (the built SPA served by the local Worker — how vev runs at a venue, §15.3).
- Install with `pnpm install --frozen-lockfile`; pnpm provisions Node itself.
- Keep lint strict. Suppress a rule only at the narrowest applicable line, with the reason: `// oxlint-disable-next-line <rule> -- <why>`.
- `vite-plus`, `oxlint`, `oxfmt` and the `vite@*` override in `pnpm-workspace.yaml` move together; that file's comments say why.

## Repository status

The pnpm workspace and Vite+ toolchain exist (M0 in §18); the `apps/*` and `packages/*` workspaces they target do not yet.

The layout planned in §4.1 (`apps/web`, `apps/api`, `packages/{shared,engines,ingest,decision}`, `services/decision-server`) is a target, not a scaffold to assume.

## Language

Write code, comments, documentation, specifications, and plans in English. Japanese belongs in `*.ja.md` mirrors, updated in the same change as the English original.

## Licensing

These rules apply from the first source file, because they are hard to retrofit:

- Every `package.json` carries `"license": "AGPL-3.0-or-later"`.
- Every source file starts with `// SPDX-License-Identifier: AGPL-3.0-or-later` (or the comment syntax of its language).
- Add only dependencies under licenses compatible with AGPL-3.0 (MIT, BSD, Apache-2.0, ISC, MPL-2.0, LGPL, GPL-3.0, AGPL-3.0). GPL-2.0-only and unknown licenses do not qualify.
- Clips are content, not vev's code: `license`, `commercialOk`, `author`, `sourceUrl`, and `modified` are mandatory on every clip, and the original license header is preserved in `originalCode`. See §14.

## Commits

- Write commit messages in English.
- Sign off every commit (`git commit -s`): the project uses the Developer Certificate of Origin, checked in CI.
- Keep unrelated work in separate commits, and land a design-document correction separately from the code it describes.
