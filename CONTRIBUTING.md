<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Contributing to vev

Thank you for your interest in contributing to vev. This document explains the project's contribution requirements — what to sign, what to license your work as, and what to run locally before opening a pull request.

## Developer Certificate of Origin (DCO)

Every commit must carry a `Signed-off-by` trailer certifying that you wrote it or otherwise have the right to submit it under the project's license, per the [Developer Certificate of Origin](https://developercertificate.org/).

Sign off with `-s` when committing:

```sh
git commit -s -m "your commit message"
```

This adds a trailer like:

```
Signed-off-by: Your Name <you@example.com>
```

If you forgot to sign off on commits already made, fix them before opening a pull request:

```sh
git rebase --signoff main
```

CI checks every commit in a pull request for this trailer and fails the build if any commit is missing it.

**There is no Contributor License Agreement (CLA).** You retain copyright over your contributions; you only certify the DCO. One consequence of not using a CLA is that vev's own code cannot be relicensed (for example, to permit a component such as `packages/decision` under a more permissive license) without the consent of every contributor to that code. Keep this in mind if you intend to contribute a substantial, self-contained piece of code you might later want relicensed.

## License of contributions

vev is licensed as a whole under **AGPL-3.0-or-later** (see §14.1 of [`docs/system-design.md`](docs/system-design.md)). This choice follows from bundling AGPL-3.0-licensed code (`hydra-synth`, and `textmode.synth.js` as its derivative) into the JavaScript served to browsers.

Every source file you add or substantially modify must carry the SPDX header appropriate to its language, as the first line of the file:

- `.ts` / `.tsx` / `.js` / `.mjs` / `.svelte`: `// SPDX-License-Identifier: AGPL-3.0-or-later`
- `.yml` / `.yaml`: `# SPDX-License-Identifier: AGPL-3.0-or-later`
- `.md`: `<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->`

## Dependency license policy

Only dependencies whose licenses are compatible with AGPL-3.0 may be added (see §14.1 of `docs/system-design.md`). GPL-2.0-only and unknown licenses are never allowed; Apache-2.0, MIT, BSD, ISC, MPL-2.0, LGPL and GPL-3.0-family licenses are compatible.

Run the license check whenever you add or upgrade a production dependency:

```sh
pnpm licenses:check
```

This runs `scripts/check-licenses.mjs`, which reads `pnpm licenses list --prod --json` and fails if any production dependency's license is not on the allow list. CI runs this same command on every push and pull request.

## Validation library

Runtime input validation (request bodies, environment values, clip and track schemas) uses [Valibot](https://valibot.dev/) ([ADR 0003](docs/adr/0003-valibot-for-validation.md) records the rationale behind that choice). Read Valibot's documentation before adding or changing a schema in `packages/shared` or in an API route.

## Local gate

Before opening a pull request, run the same checks CI runs:

```sh
pnpm install
pnpm check
pnpm test
pnpm licenses:check
```

`pnpm check` runs type checking, linting (`oxlint`) and format checking (`oxfmt`) together. All four commands must pass locally; a pull request whose branch fails any of them will fail CI.

### What the gate does not cover

`pnpm check`'s type checking and linting run over `.ts` files (and the script blocks of `.svelte` files) with full type-aware rules. It does **not** type-check `.svelte` template expressions or catch `.svelte`-specific type errors: `oxlint` reaches a component's `<script>` block with syntactic rules only, and `svelte-check` — the tool that would cover templates — is deliberately not part of the gate, because it crashes against this repository's TypeScript 7.0.2 and would require carrying a second TypeScript major just to run it.

In practice this means: a type error inside a `<script>` block is caught; a type error in a template expression (`{someProp.typo}`, a mismatched prop, an event handler with the wrong signature) is not caught by CI and will only surface at runtime or in your editor. Write accordingly — keep logic and types in `.ts` modules, keep `.svelte` components thin (props in, markup out), and verify a component you changed by actually running it (`pnpm dev` / `pnpm live`), not by relying on the gate to catch a template mistake.

## Clips are content, not code

Clips (Hydra / textmode sketches and their metadata) are content and keep their own authors' licenses — they are not part of vev's codebase license. Per §14.2 of `docs/system-design.md`, the repository does **not** ship third-party clips. The only clips that may be included are the vev authors' own examples, under `examples/clips/`, each with its own per-file license header. Do not submit clips written by anyone else, even under a permissive license — they do not belong in this repository.

## Adding an engine or a decision provider

If your contribution adds a new render engine or a new decision provider, read [`docs/system-design.md`](docs/system-design.md) first for the extension points and contracts each of those must satisfy.
