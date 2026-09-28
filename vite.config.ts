// SPDX-License-Identifier: AGPL-3.0-or-later
/* oxlint-disable eslint/sort-keys -- sections here are ordered by topic (lint → fmt), not alphabetically */
// vev unified toolchain config (Vite+ / `vp`): test, lint (oxlint) and fmt (oxfmt)
// in one file. `vp lint` / `vp fmt` / `vp check`.
//
// Lint philosophy — near-full-strict from day one. This repo is written fresh,
// so the Ultracite presets (core + anti-slop + vitest) run UNCURATED except for
// the handful of exclusions that are structural rather than taste:
//   1. tool conflicts (a fixer/formatter fight, a framework false positive),
//   2. rules that would WEAKEN assertions,
//   3. the test-fixture latitude every codebase needs.
// Deliberate exceptions in code use `// oxlint-disable-next-line <rule> -- reason`;
// keep them rare and reasoned.
import oxfmtPreset from 'ultracite/oxfmt'
import antiSlop from 'ultracite/oxlint/anti-slop'
import core from 'ultracite/oxlint/core'
import vitest from 'ultracite/oxlint/vitest'
import { defineConfig } from 'vite-plus'

export default defineConfig({
  lint: {
    extends: [core, antiSlop, vitest],
    // .superpowers/** is excluded: plan files under it embed indented code
    // fragments meant to be pasted into an existing block (a describe body, an
    // interface), and linting/formatting each fenced block as a standalone file
    // would flag or rewrite that deliberate indentation.
    // apps/web/e2e/** is excluded for one structural reason: those scripts import `playwright`,
    // which is deliberately NOT a dependency of this repository (they are a manual browser check,
    // run via `npx --package`, and the gate must never pull a browser download). Type-aware lint
    // therefore cannot resolve that import, and every rule downstream of it reports on an `any`.
    // They are still formatted by oxfmt — only lint skips them. See apps/web/e2e/README.md.
    ignorePatterns: [
      '**/worker-configuration.d.ts',
      '**/.svelte-kit/**',
      '**/build/**',
      '.superpowers/**',
      'apps/web/e2e/**',
    ],
    options: {
      typeAware: true,
      typeCheck: true,
    },
    rules: {
      // -- structural exclusions (not taste) ----------------------------------
      // The fixer adds parentheses around nested ternaries; oxfmt strips them
      // again. The two tools cannot both be satisfied, in any codebase:
      'unicorn/no-nested-ternary': 'off',
      // False positive on Hono middleware (`await next()`):
      'node/callback-return': 'off',
      // False positive on Hono middleware: MiddlewareHandler's contract is
      // Response | void, so returning a Response on the early-exit path and
      // nothing on the happy path is the API:
      'typescript/consistent-return': 'off',
      // -- config, not off ----------------------------------------------------
      // Svelte components keep PascalCase names (Source.svelte); everything else kebab:
      'unicorn/filename-case': ['error', { cases: { kebabCase: true, pascalCase: true } }],
    },
    overrides: [
      // Vitest preset curation must live at override level (the preset applies
      // its rules via a test-file override, which top-level `rules` cannot beat).
      // `plugins: ['vitest']` is required here too: an override without its own
      // `plugins` list only inherits the base (non-test) `lint.plugins` list,
      // which doesn't include vitest, so `vitest/*` keys below are silently
      // dropped without it.
      {
        files: ['**/*.test.ts', '**/test/**'],
        env: { jest: true },
        plugins: ['vitest'],
        rules: {
          // These two rewrite exact `toBe(true/false)` into truthy/falsy checks —
          // they WEAKEN assertions, so they stay off even in a strict setup:
          'vitest/prefer-to-be-truthy': 'off',
          'vitest/prefer-to-be-falsy': 'off',
          // Test-fixture latitude: fakes and fixtures are built by casting.
          // All of these stay fully enforced in src:
          'typescript/no-explicit-any': 'off',
          'typescript/no-non-null-assertion': 'off',
          'anti-slop/no-chained-type-assertions': 'off',
          'anti-slop/no-unknown-parameters': 'off',
          'anti-slop/no-unknown-returns': 'off',
          'anti-slop/no-module-mocking': 'off',
          'anti-slop/require-safety-comment-for-type-assertion': 'off',
          // Same latitude for the `env as unknown as Env` casts the
          // vitest-pool-workers harness forces in test setup and fixtures:
          'typescript/no-unsafe-type-assertion': 'off',
          // `cloudflare:test`'s `env` and `SELF` are deprecated in favour of
          // `cloudflare:workers`'s request-scoped API, which does not work in
          // top-level test setup or outside a request — tests keep using the
          // harness API instead:
          'typescript/no-deprecated': 'off',
        },
      },
      // Cloudflare Worker entry code runs in the workerd global scope:
      {
        files: ['apps/api/src/**'],
        env: { serviceworker: true },
      },
    ],
  },

  fmt: {
    // Ultracite defaults plus the vev house style.
    ...oxfmtPreset,
    printWidth: 110,
    semi: false,
    // Top-level, not scoped: oxfmt's formatting worker resolves
    // `prettier-plugin-svelte` (and therefore `svelte/compiler`) eagerly whenever
    // this option is set anywhere in the active config, so it used to break
    // `vp check`/`vp fmt` for the whole repo before any package had installed
    // `svelte`. Now that apps/web (Task 5) installs `svelte`, the top-level
    // option resolves fine and is simpler than the file-scoped override it
    // replaces — confirmed by a deliberately mangled .svelte file: `vp check`
    // both flags it and leaves the rest of the repo unaffected.
    svelte: true,
    singleQuote: true,
    trailingComma: 'all',
    // Markdown prose is one paragraph per line; the viewer soft-wraps it, so a
    // reworded sentence diffs as one line rather than a reflowed block.
    proseWrap: 'never',
    // .superpowers/** is excluded: plan files under it embed indented code
    // fragments meant to be pasted into an existing block (a describe body, an
    // interface), and formatting each fenced block as a standalone file
    // dedents that deliberate indentation, turning a paste-in fragment into
    // what reads as top-level code.
    ignorePatterns: [
      ...(oxfmtPreset.ignorePatterns ?? []),
      '**/.svelte-kit/**',
      '**/build/**',
      '.superpowers/**',
    ],
  },
})
