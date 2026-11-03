// SPDX-License-Identifier: AGPL-3.0-or-later
import * as v from 'valibot'
import { defineConfig } from 'void/config'

import { targets } from './deploy-targets.ts'

const target = v.parse(v.picklist(['local', 'preview', 'production']), process.env.VEV_TARGET ?? 'local')

export default defineConfig({
  cloudflare: targets[target],
  inference: { appType: 'void', bindings: { db: false } },
  routing: { notFound: 'none' },
})
