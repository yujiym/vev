// SPDX-License-Identifier: AGPL-3.0-or-later
import { healthResponseSchema } from '@vev/shared'
import { count } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import * as v from 'valibot'

import { settingsTable } from './db/schema.ts'
import type { Env } from './env.ts'

const app = new Hono<{ Bindings: Env }>().basePath('/api')

const routes = app.get('/health', async (c) => {
  const db = drizzle(c.env.DB)
  const [row] = await db.select({ value: count() }).from(settingsTable)

  return c.json(
    v.parse(healthResponseSchema, {
      commit: 'dev',
      mode: c.env.VEV_MODE,
      ok: true,
      settingsRows: row?.value ?? 0,
    }),
  )
})

export type AppType = typeof routes

export default app
