// SPDX-License-Identifier: AGPL-3.0-or-later
import { healthResponseSchema } from '@vev/shared'
import { Hono } from 'hono'
import * as v from 'valibot'

import type { Env } from './env.ts'

const app = new Hono<{ Bindings: Env }>().basePath('/api')

const routes = app.get('/health', (c) =>
  c.json(
    v.parse(healthResponseSchema, {
      commit: 'dev',
      mode: c.env.VEV_MODE,
      ok: true,
      settingsRows: 0,
    }),
  ),
)

export type AppType = typeof routes

export default app
