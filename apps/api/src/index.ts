// SPDX-License-Identifier: AGPL-3.0-or-later
import { healthResponseSchema } from '@vev/shared'
import { count } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import * as v from 'valibot'

import { requireAccessAssertion } from './access.ts'
import { settingsTable } from './db/schema.ts'
import type { Env } from './env.ts'
import { clipsRoutes } from './routes/clips.ts'

const app = new Hono<{ Bindings: Env }>().basePath('/api')

// Mounted FIRST, ahead of every route (§13). /health is the only public
// route — it's named explicitly here, not inferred from registration order,
// so a future owner route stays guarded no matter how it's chained onto
// `routes` below (see requireAccessAssertion's doc comment for why order
// alone isn't safe).
app.use('/*', requireAccessAssertion(new Set(['/api/health'])))

const routes = app.get('/health', async (c) => {
  const db = drizzle(c.env.DB)
  const [row] = await db.select({ value: count() }).from(settingsTable)

  return c.json(
    v.parse(healthResponseSchema, {
      commit: c.env.GIT_COMMIT,
      mode: c.env.VEV_MODE,
      ok: true,
      settingsRows: row?.value ?? 0,
    }),
  )
})

const withClips = routes.route('/clips', clipsRoutes)

export type AppType = typeof withClips

export default app
