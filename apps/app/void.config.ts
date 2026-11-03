// SPDX-License-Identifier: AGPL-3.0-or-later
import { execFileSync } from 'node:child_process'

import * as v from 'valibot'
import { defineConfig } from 'void/config'

import { targets } from './deploy-targets.ts'

const target = v.parse(v.picklist(['local', 'preview', 'production']), process.env.VEV_TARGET ?? 'local')

// AGPL §13 source offer (§14.1): the Worker's GIT_COMMIT names the exact commit this build serves, and
// both /api/health and the layout's Source link read it. `git rev-parse` fails in a tarball build with
// no `.git`, which is why `dev` — "no commit known", rendered as a link to the repository itself — is
// the last resort. A shell GIT_COMMIT (a release pipeline exporting its own) wins over both.
const gitCommit = (): string => {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
      cwd: import.meta.dirname,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
      .toString()
      .trim()
  } catch {
    return 'dev'
  }
}

export default defineConfig({
  cloudflare: {
    ...targets[target],
    vars: { ...targets[target].vars, GIT_COMMIT: process.env.GIT_COMMIT ?? gitCommit() },
  },
  // What the old `app.html` carried: the pages are built for a phone or tablet as well as a laptop.
  head: {
    htmlAttrs: { lang: 'en' },
    meta: [{ charset: 'utf-8' }, { content: 'width=device-width, initial-scale=1', name: 'viewport' }],
  },
  // Void infers an AI binding from any `env.AI` in the source, which makes `vp preview` open a remote
  // session that needs a Cloudflare login and a network. `deploy-targets.ts` alone decides who gets one.
  inference: { appType: 'void', bindings: { ai: false, db: false }, build: 'vp build' },
  // The stage lives at `/` (ADR 0012). Old bookmarks of the screens it replaced land on it.
  routing: { notFound: 'none', redirects: { '/output': '/', '/studio': '/', '/studio/*': '/' } },
})
