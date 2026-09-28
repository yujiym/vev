// SPDX-License-Identifier: AGPL-3.0-or-later
import { vValidator } from '@hono/valibot-validator'
import { newTrackSchema, trackSchema } from '@vev/shared'
import type { Track, TrackItem } from '@vev/shared'
import { asc, eq, inArray } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import * as v from 'valibot'

import { clipsTable } from '../db/clips.ts'
import { trackItemsTable, tracksTable } from '../db/tracks.ts'
import type { Env } from '../env.ts'

/**
 * §13: vev is single-owner through M2 — Cloudflare Access decides *whether* a request is the
 * owner, and there is exactly one. So `ownerId` is a constant here rather than read off the
 * Access assertion: the assertion is only presence-checked (see `src/access.ts`), so any identity
 * derived from it today would be a guess dressed as a fact. It stays a server-set column (absent
 * from `newTrackSchema` by construction) so the day a second owner exists, only this line moves.
 */
const OWNER_ID = 'owner'

/** Turns a title into a URL-safe slug, disambiguated by the track's own opaque id — same rule as `routes/clips.ts`. */
const slugify = (title: string, id: string): string => {
  const words = title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
  return `${words === '' ? 'track' : words}-${id.slice(0, 8)}`
}

type Db = DrizzleD1Database
type TrackRow = typeof tracksTable.$inferSelect
type TrackItemRow = typeof trackItemsTable.$inferSelect

/**
 * D1 returns SQL `NULL` for absent optional columns and valibot's `v.optional` only recognizes
 * `undefined`, so a row read straight back would fail its own schema — the same conversion
 * `routes/clips.ts` does for clips, named field-by-field for the same reason.
 */
const itemFromRow = (row: TrackItemRow): TrackItem => ({
  bars: row.bars ?? undefined,
  clipId: row.clipId,
  section: row.section ?? undefined,
  transitionIn: row.transitionIn ?? undefined,
})

const trackFromRows = (row: TrackRow, items: readonly TrackItemRow[]): Track =>
  v.parse(trackSchema, {
    ...row,
    bpmDefault: row.bpmDefault ?? undefined,
    items: items.map((item) => itemFromRow(item)),
  })

const itemRowsFor = (trackId: string, items: readonly TrackItem[]): TrackItemRow[] =>
  items.map((item, position) => ({
    bars: item.bars ?? null,
    clipId: item.clipId,
    id: crypto.randomUUID(),
    position,
    section: item.section ?? null,
    trackId,
    transitionIn: item.transitionIn ?? null,
  }))

const readTrack = async (db: Db, id: string): Promise<Track | undefined> => {
  const [row] = await db.select().from(tracksTable).where(eq(tracksTable.id, id))
  if (row === undefined) {
    return undefined
  }

  const items = await db
    .select()
    .from(trackItemsTable)
    .where(eq(trackItemsTable.trackId, id))
    .orderBy(asc(trackItemsTable.position))

  return trackFromRows(row, items)
}

/**
 * Checks every item against the clips table before anything is written, and returns the refusal
 * message for the first item that fails — or `undefined` when they all pass.
 *
 * Two failures live here, and both are about a track claiming something it cannot back up:
 *
 * - An item pointing at a clip that does not exist. The `track_items.clip_id` foreign key would
 *   also refuse it, but as an opaque constraint error with no clip in it; a track editor needs to
 *   say *which* item is broken.
 * - Spec §14.2: "With `Track.mode = "commercial"`, clips with `commercialOk = false` are excluded
 *   from candidates and tracks (with a warning)." A licensing rule that exists only in the spec is
 *   not a rule, so it is enforced here, at the only place a track is written, and the message
 *   names the offending clip — the performer has to find it in a list to remove it.
 */
const refuseItems = async (
  db: Db,
  items: readonly TrackItem[],
  mode: Track['mode'],
): Promise<string | undefined> => {
  if (items.length === 0) {
    return undefined
  }

  // `inArray` with an empty list is not valid SQL, which the guard above already prevents; the
  // de-duplication is just to keep the `in (...)` list proportional to distinct clips, since the
  // same clip legitimately appears more than once in a track.
  const ids = [...new Set(items.map((item) => item.clipId))]
  const rows = await db
    .select({ commercialOk: clipsTable.commercialOk, id: clipsTable.id, title: clipsTable.title })
    .from(clipsTable)
    .where(inArray(clipsTable.id, ids))
  const byId = new Map(rows.map((row) => [row.id, row]))

  for (const [index, item] of items.entries()) {
    // Counted from 1, matching the ordered list the editor renders — a message that says "item 0"
    // sends the performer to the wrong row.
    const position = index + 1
    const clip = byId.get(item.clipId)
    if (clip === undefined) {
      return `item ${position} references clip "${item.clipId}", which does not exist`
    }
    if (mode === 'commercial' && !clip.commercialOk) {
      return `item ${position} is "${clip.title}" (${clip.id}), which is not cleared for commercial use; this track's mode is "commercial" (§14.2)`
    }
  }

  return undefined
}

/**
 * A track edit. Every field of `newTrackSchema` is optional, and it stays strict, so a
 * server-owned field (`id`, `ownerId`, `slug`) is a 400 rather than a silently dropped key — the
 * same treatment `clipPatchSchema` gives a client-supplied `id`.
 */
const trackPatchSchema = v.partial(newTrackSchema)

export const tracksRoutes = new Hono<{ Bindings: Env }>()
  .post('/', vValidator('json', newTrackSchema), async (c) => {
    const body = c.req.valid('json')
    const db = drizzle(c.env.DB)

    const refusal = await refuseItems(db, body.items, body.mode)
    if (refusal !== undefined) {
      return c.text(refusal, 400)
    }

    const id = crypto.randomUUID()
    const row: TrackRow = {
      bpmDefault: body.bpmDefault ?? null,
      defaultTransition: body.defaultTransition,
      id,
      mode: body.mode,
      ownerId: OWNER_ID,
      slug: slugify(body.title, id),
      title: body.title,
      visibility: body.visibility,
    }
    const itemRows = itemRowsFor(id, body.items)

    // `drizzle-orm/d1` has no `transaction`, so the track and its items go in one `batch` — a
    // failing item insert must not leave a track row behind with no items, which would read to
    // the editor as a track the performer emptied on purpose.
    await (itemRows.length === 0
      ? db.insert(tracksTable).values(row)
      : db.batch([db.insert(tracksTable).values(row), db.insert(trackItemsTable).values(itemRows)]))

    return c.json(trackFromRows(row, itemRows), 201)
  })
  .get('/', async (c) => {
    const db = drizzle(c.env.DB)

    // Two queries, not one per track: a list of five tracks must not become six round trips.
    const rows = await db.select().from(tracksTable).orderBy(asc(tracksTable.title))
    const items = await db.select().from(trackItemsTable).orderBy(asc(trackItemsTable.position))

    const byTrack = new Map<string, TrackItemRow[]>()
    for (const item of items) {
      const bucket = byTrack.get(item.trackId)
      if (bucket === undefined) {
        byTrack.set(item.trackId, [item])
      } else {
        bucket.push(item)
      }
    }

    const tracks = rows.map((row) => trackFromRows(row, byTrack.get(row.id) ?? []))
    return c.json({ tracks })
  })
  .get('/:id', async (c) => {
    const track = await readTrack(drizzle(c.env.DB), c.req.param('id'))
    if (track === undefined) {
      return c.text('Not Found', 404)
    }

    return c.json(track)
  })
  .patch('/:id', vValidator('json', trackPatchSchema), async (c) => {
    const db = drizzle(c.env.DB)
    const id = c.req.param('id')
    const patch = c.req.valid('json')

    const existing = await readTrack(db, id)
    if (existing === undefined) {
      return c.text('Not Found', 404)
    }

    // Validated against the MERGED track, not against the patch: `{"mode": "commercial"}` alone
    // carries no items, but it is exactly the edit that can make the items already stored illegal
    // (§14.2). Checking only what the patch names would let that edit through.
    const items = patch.items ?? existing.items
    const mode = patch.mode ?? existing.mode
    const refusal = await refuseItems(db, items, mode)
    if (refusal !== undefined) {
      return c.text(refusal, 400)
    }

    const update: Partial<typeof tracksTable.$inferInsert> = {}
    if (patch.bpmDefault !== undefined) {
      update.bpmDefault = patch.bpmDefault
    }
    if (patch.defaultTransition !== undefined) {
      update.defaultTransition = patch.defaultTransition
    }
    if (patch.mode !== undefined) {
      update.mode = patch.mode
    }
    if (patch.title !== undefined) {
      update.title = patch.title
    }
    if (patch.visibility !== undefined) {
      update.visibility = patch.visibility
    }

    if (Object.keys(update).length > 0) {
      await db.update(tracksTable).set(update).where(eq(tracksTable.id, id))
    }

    // Items are replaced wholesale rather than diffed: `position` is the item's identity to the
    // editor, and a reorder rewrites every position anyway. Delete and insert travel in one
    // `batch` so a failed insert cannot empty the track (see the POST comment above).
    if (patch.items !== undefined) {
      const itemRows = itemRowsFor(id, patch.items)
      const remove = db.delete(trackItemsTable).where(eq(trackItemsTable.trackId, id))
      await (itemRows.length === 0 ? remove : db.batch([remove, db.insert(trackItemsTable).values(itemRows)]))
    }

    const updated = await readTrack(db, id)
    if (updated === undefined) {
      return c.text('Not Found', 404)
    }

    return c.json(updated)
  })
