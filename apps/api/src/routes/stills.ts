// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import * as v from 'valibot'

import { clipsTable } from '../db/clips.ts'
import type { Env } from '../env.ts'
import { enqueueAnnotation } from '../ingest/consume.ts'

/** Annotation asks about at most this many frames; more would only spend jev's 32,000-token context. */
const MAX_STILLS = 3

/** A 512-pixel JPEG is tens of kilobytes. 2 MiB is far above any honest still and far below TypeSafe's 16 MiB. */
const MAX_STILL_BYTES = 2 * 1024 * 1024

/** SOI plus the first marker byte: what every JPEG starts with, whatever its `Content-Type` claims. */
const JPEG_MAGIC = [0xff, 0xd8, 0xff]

const FIELD = 'still'

/** Every upload gets its own prefix, so a replacement never overwrites an object the row still names. */
const stillKeyFor = (clipId: string, uploadId: string, index: number): string =>
  `stills/${clipId}/${uploadId}/${index}.jpg`

/** Deleting is housekeeping: an object left behind is private and unreferenced, so a failure only logs. */
const discard = async (env: Env, keys: readonly string[]): Promise<void> => {
  if (keys.length === 0) {
    return
  }
  try {
    await env.MEDIA.delete([...keys])
  } catch (error) {
    console.error('stills: could not delete unreferenced objects', keys, error)
  }
}

const startsWithJpegMagic = async (file: File): Promise<boolean> => {
  const head = new Uint8Array(await file.slice(0, JPEG_MAGIC.length).arrayBuffer())
  return JPEG_MAGIC.every((byte, index) => head[index] === byte)
}

const filesSchema = v.pipe(
  v.array(v.pipe(v.instance(File), v.maxSize(MAX_STILL_BYTES), v.minSize(1))),
  v.minLength(1),
  v.maxLength(MAX_STILLS),
)

/**
 * `POST /api/clips/:id/stills` — the rendered frames annotation judges a clip against (ADR 0010),
 * as `multipart/form-data` with one `still` part per JPEG, in recording order. An owner route,
 * like the thumbnail upload beside it.
 *
 * All the keys are written in ONE update after every object is stored, so a half-uploaded set is
 * never visible to the consumer. A replacement writes under new keys and deletes the old objects
 * only after the row names the new ones, so a failure at any point leaves the previous set whole.
 * Stills are private: `GET /media/:key` authorises by `thumbnail_key` and does not serve them.
 *
 * It enqueues annotation again once the keys are recorded. Registration enqueues first, before the
 * browser has uploaded anything, so without this the consumer would read the row while it has no
 * stills and every clip would be annotated from its code alone. Both annotations write the same
 * columns; the registration one only fills a clip that is still `pending`, so the stills one wins.
 */
export const clipStillsRoutes = new Hono<{ Bindings: Env }>().post('/:id/stills', async (c) => {
  const id = c.req.param('id')
  const db = drizzle(c.env.DB)

  const [existing] = await db
    .select({ id: clipsTable.id, stillKeys: clipsTable.stillKeys })
    .from(clipsTable)
    .where(eq(clipsTable.id, id))
  if (existing === undefined) {
    return c.text('Not Found', 404)
  }

  const form = await c.req.parseBody({ all: true }).catch(() => null)
  const field = form?.[FIELD]
  const parsed = v.safeParse(filesSchema, field === undefined ? [] : [field].flat())
  if (!parsed.success) {
    return c.text(
      `Send 1-${MAX_STILLS} non-empty JPEGs of at most ${MAX_STILL_BYTES} bytes as multipart "${FIELD}" parts`,
      400,
    )
  }

  const files = parsed.output
  const magic = await Promise.all(files.map(startsWithJpegMagic))
  if (magic.includes(false)) {
    return c.text('Every still must be a JPEG', 400)
  }

  const uploadId = crypto.randomUUID()
  const uploads = files.map((file, index) => ({ file, key: stillKeyFor(id, uploadId, index) }))
  const keys = uploads.map((upload) => upload.key)
  try {
    // Settled, not `all`: a rejection must not return while the other puts are still landing, or
    // the cleanup below would run before the objects it has to delete exist.
    const puts = await Promise.allSettled(
      uploads.map(
        async ({ file, key }) =>
          await c.env.MEDIA.put(key, await file.arrayBuffer(), {
            httpMetadata: { contentType: 'image/jpeg' },
          }),
      ),
    )
    const failed = puts.find((put) => put.status === 'rejected')
    if (failed !== undefined) {
      throw failed.reason
    }
    await db.update(clipsTable).set({ stillKeys: keys }).where(eq(clipsTable.id, id))
  } catch (error) {
    await discard(c.env, keys)
    throw error
  }
  await discard(c.env, existing.stillKeys ?? [])

  try {
    await enqueueAnnotation(c.env, id, 'stills')
  } catch (error) {
    console.error(`stills: could not re-enqueue annotation for ${id}`, error)
  }

  return c.json({ stillKeys: keys }, 201)
})
