// SPDX-License-Identifier: AGPL-3.0-or-later
import { healthResponseSchema } from '@vev/shared'
import { count } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import * as v from 'valibot'

import { requireAccessAssertion } from './access.ts'
import { settingsTable } from './db/schema.ts'
import type { Env } from './env.ts'
import { ingestQueue } from './ingest/consume.ts'
import { clipsRoutes } from './routes/clips.ts'
import { clipThumbnailRoutes, mediaRoutes } from './routes/media.ts'
import { tracksRoutes } from './routes/tracks.ts'

const api = new Hono<{ Bindings: Env }>().basePath('/api')

// Mounted FIRST, ahead of every route (§13). /health is the only public
// route — it's named explicitly here, not inferred from registration order,
// so a future owner route stays guarded no matter how it's chained onto
// `routes` below (see requireAccessAssertion's doc comment for why order
// alone isn't safe).
api.use('/*', requireAccessAssertion(new Set(['/api/health'])))

const routes = api.get('/health', async (c) => {
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

// Every owner route is chained onto the same const, so it is covered by the
// `requireAccessAssertion` mounted above (see that middleware's doc comment on
// why coverage is by explicit skip set rather than by registration order).
const withLibrary = routes
  .route('/clips', clipsRoutes)
  .route('/clips', clipThumbnailRoutes)
  .route('/tracks', tracksRoutes)

export type AppType = typeof withLibrary

/**
 * `/media/*` is mounted on the top-level app, alongside `/api`, not inside it — `GET /media/:key`
 * (`src/routes/media.ts`) is a deliberately public route (thumbnails render in a library UI a
 * viewer may reach with no owner login) and must never pass through `requireAccessAssertion`,
 * which is scoped to `/api/*` above. Its own authorization is the `clips` row lookup inside the
 * route itself, not this mount point — see that file's doc comment.
 */
const app = new Hono<{ Bindings: Env }>().route('/', api).route('/media', mediaRoutes)

/**
 * The Worker exports two handlers, not one. `fetch` serves the API and the SPA; `queue` is the
 * annotation consumer (§11.1 — annotation is slow, so it runs asynchronously off the `INGEST`
 * queue that `POST /api/clips` writes to). Both live on the same deployed artifact, which is what
 * §15.3 requires: one build runs at a venue, whether or not a queue exists there to feed it.
 */
export default {
  fetch: app.fetch,
  queue: ingestQueue,
} satisfies ExportedHandler<Env>
