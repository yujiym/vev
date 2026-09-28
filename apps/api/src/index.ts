// SPDX-License-Identifier: AGPL-3.0-or-later
import { healthResponseSchema } from '@vev/shared'
import { count } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import * as v from 'valibot'

import { requireAccessAssertion } from './access.ts'
import { settingsTable } from './db/schema.ts'
import type { Env } from './env.ts'

const app = new Hono<{ Bindings: Env }>().basePath('/api')

// /health is public by design (the smoke test depends on it) and is
// registered before the guard below, so it never reaches it: Hono composes
// matched handlers in registration order, and this route's handler doesn't
// call `next()`. Every other /api/* route added from here on is an owner
// route and passes through the guard first (§13).
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

// Applies to every /api/* route registered after this point (none yet — see
// the comment above `routes`). Registered after `/health` so it can never
// run ahead of that handler; must stay registered before any owner route
// this file gains next (Task 3+).
app.use('/*', requireAccessAssertion)

export type AppType = typeof routes

export default app
