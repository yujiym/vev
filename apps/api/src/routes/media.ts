// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'

import { clipsTable } from '../db/clips.ts'
import type { Env } from '../env.ts'

/** A year is long enough that a thumbnail — content-addressed by clip id, never overwritten in place — never needs revalidation. */
const MEDIA_CACHE_CONTROL = 'public, max-age=31536000, immutable'

const thumbnailKeyFor = (clipId: string): string => `thumbnails/${clipId}.webm`

/**
 * `POST /api/clips/:id/thumbnail` — accepts the registration screen's recorded WebM
 * (`recordThumbnail`, `apps/web/src/lib/palette.ts`), writes it to `MEDIA` under a key derived
 * from the clip id, and records that key on the clip's row. An owner route (mounted under `/api`,
 * behind `requireAccessAssertion`) — only the registrant who just ran the probe uploads a
 * thumbnail for their own clip.
 */
export const clipThumbnailRoutes = new Hono<{ Bindings: Env }>().post('/:id/thumbnail', async (c) => {
  const id = c.req.param('id')
  const db = drizzle(c.env.DB)

  const [existing] = await db.select({ id: clipsTable.id }).from(clipsTable).where(eq(clipsTable.id, id))
  if (existing === undefined) {
    return c.text('Not Found', 404)
  }

  const contentType = c.req.header('content-type')
  const body = await c.req.arrayBuffer()
  if (body.byteLength === 0) {
    return c.text('Thumbnail body must not be empty', 400)
  }

  const key = thumbnailKeyFor(id)
  await c.env.MEDIA.put(key, body, {
    httpMetadata: {
      contentType: contentType === undefined || contentType === '' ? 'video/webm' : contentType,
    },
  })
  await db.update(clipsTable).set({ thumbnailKey: key }).where(eq(clipsTable.id, id))

  return c.json({ thumbnailKey: key }, 201)
})

/**
 * `GET /media/:key` — the public route that serves clip thumbnails (and, in future, other clip
 * media) back to the browser. Mounted OUTSIDE `/api` (see `src/index.ts`), so it is not behind
 * `requireAccessAssertion`: thumbnails are shown in a library UI a viewer may reach without an
 * owner login.
 *
 * Being public is exactly why this checks more than a prefix. A `thumbnails/`-prefixed key alone
 * would make every object in that R2 prefix readable by anyone who can guess or enumerate a UUID —
 * a bucket lister wearing a media route's clothes, not a media route. This instead requires the
 * key to appear as some row's `thumbnail_key` — the same authorization decision the row's own
 * existence already encodes — before it ever asks R2 for the bytes. A well-formed key with no
 * matching row is refused the same as a missing one: both read as "not found" to the caller,
 * which leaks nothing about whether the object itself exists in the bucket.
 */
export const mediaRoutes = new Hono<{ Bindings: Env }>().get('/:key{.+}', async (c) => {
  const key = c.req.param('key')
  const db = drizzle(c.env.DB)

  const [owner] = await db
    .select({ id: clipsTable.id })
    .from(clipsTable)
    .where(eq(clipsTable.thumbnailKey, key))
  if (owner === undefined) {
    return c.text('Not Found', 404)
  }

  const object = await c.env.MEDIA.get(key)
  if (object === null) {
    return c.text('Not Found', 404)
  }

  return new Response(object.body, {
    headers: {
      'cache-control': MEDIA_CACHE_CONTROL,
      'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
    },
  })
})
