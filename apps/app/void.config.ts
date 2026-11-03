// SPDX-License-Identifier: AGPL-3.0-or-later
import * as v from 'valibot'
import { defineConfig } from 'void/config'

import { targets } from './deploy-targets.ts'

const target = v.parse(v.picklist(['local', 'preview', 'production']), process.env.VEV_TARGET ?? 'local')

export default defineConfig({
  cloudflare: targets[target],
  // Void infers an AI binding from any `env.AI` in the source, which makes `vp preview` open a remote
  // session that needs a Cloudflare login and a network. `deploy-targets.ts` alone decides who gets one.
  inference: { appType: 'void', bindings: { ai: false, db: false } },
  routing: { notFound: 'none' },
})
