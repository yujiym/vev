<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Contributing to vev

## Sign off every commit

Commit with `-s`. That adds a `Signed-off-by` trailer certifying you wrote the change or may submit it under this licence, per the [Developer Certificate of Origin](https://developercertificate.org/). CI checks every commit in a pull request and fails if one is missing it; `git rebase --signoff main` fixes commits already made.

**There is no CLA** — you keep your copyright. The consequence worth knowing before you contribute: vev's code cannot later be relicensed without the consent of everyone who wrote part of it.

## Licence and headers

vev is **AGPL-3.0-or-later** as a whole, because it bundles AGPL code (`hydra-synth`) into the JavaScript it serves (§14.1 of [`docs/spec.md`](docs/spec.md)). Every file you add starts with an SPDX header in its own comment syntax — `//` for TypeScript and Svelte, `#` for YAML, `<!-- -->` for Markdown. JSON has none; `package.json` carries a `license` field instead.

Only dependencies with AGPL-3.0-compatible licences may be added: MIT, BSD, ISC, Apache-2.0, MPL-2.0, LGPL and the GPL-3.0 family are fine; GPL-2.0-only and unknown are not. `pnpm licenses:check` enforces it, in CI and locally.

## Local gate

Before opening a pull request, run the same checks CI runs:

```sh
pnpm install
pnpm check
pnpm test
pnpm licenses:check
```

`pnpm check` runs type checking, linting (`oxlint`) and format checking (`oxfmt`) together. All four must pass locally; a branch that fails any of them fails CI. Schemas use [Valibot](https://valibot.dev/) ([ADR 0003](docs/adr/0003-valibot-for-validation.md)).

### The gate does not see Svelte templates

A type error inside a `<script>` block is caught; one in a template expression — a typo'd prop, a handler with the wrong signature — is not. `oxlint` reaches script blocks with syntactic rules only, and `svelte-check` is deliberately absent because it cannot run against this repository's TypeScript ([ADR 0001](docs/adr/0001-vite-plus-toolchain.md)). So keep logic and types in `.ts` modules, keep components thin, and check a component you changed by running it.

## Clips are content, not code

Clips (Hydra / textmode sketches and their metadata) are content and keep their own authors' licenses — they are not part of vev's codebase license. Per §14.2 of `docs/spec.md`, the repository does **not** ship third-party clips. The only clips that may be included are the vev authors' own examples, under `examples/clips/`, each with its own per-file license header. Do not submit clips written by anyone else, even under a permissive license — they do not belong in this repository.
