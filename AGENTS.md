# AGENTS.md

Guidance for AI coding agents working in this repository.

## Design reference

[docs/system-design.md](docs/system-design.md) is the canonical design of vev. Before implementing a milestone (§18), read the sections it depends on, and record any question the design does not answer in §17 of that document rather than deciding it silently in code.

The design describes software that does not exist yet: treat every section as intent, and the repository as the authority on what is built. Keep `docs/system-design.md` current when a decision changes the design — the root name `DESIGN.md` is reserved for design principles, so this document stays under `docs/`.

## Repository status

The repository holds documentation only. There is no package manifest, build, or test command yet; M0 in §18 creates them. Add a Toolchain section here when it does, describing the commands that actually exist.

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
