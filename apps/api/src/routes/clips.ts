// SPDX-License-Identifier: AGPL-3.0-or-later
import { vValidator } from '@hono/valibot-validator'
// The pure entry (`@vev/engines`, not `@vev/engines/hydra`) — string transforms over clip source
// with no renderer behind them. `@vev/engines/hydra` pulls in `hydra-synth`, which touches
// `window` at import time and must never reach a Worker.
import { countOutCalls, MULTI_OUTPUT_MESSAGE } from '@vev/engines'
import { analyzeHydra, normalizeHydra } from '@vev/ingest'
import {
  clipDensitySchema,
  clipEnergySchema,
  clipLayerHintSchema,
  clipMotionSchema,
  clipSchema,
  clipSummarySchema,
  engineKindSchema,
  newClipSchema,
} from '@vev/shared'
import type { Clip, ClipDeps } from '@vev/shared'
import { and, eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import * as v from 'valibot'

import { clipsTable } from '../db/clips.ts'
import type { Env } from '../env.ts'
import { enqueueAnnotation } from '../ingest/consume.ts'

/** No feedback, no extra outputs, no sources, no audio, no extensions — every engine `analyzeHydra` doesn't cover yet starts here. */
const EMPTY_DEPS: ClipDeps = {
  extensions: [],
  outputsUsed: [],
  sourcesUsed: [],
  usesAudio: false,
  usesFeedback: false,
}

/**
 * Turns a title into a URL-safe slug when the registrant didn't supply one. Collisions are
 * resolved by suffixing the new clip's id (opaque, always unique) rather than a counter, which
 * would need another read.
 */
const slugify = (engine: string, title: string, id: string): string => {
  const words = title
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/gu, '-')
    .replaceAll(/^-+|-+$/gu, '')
  return `${engine}/${words === '' ? 'clip' : words}-${id.slice(0, 8)}`
}

/**
 * Whether a failed insert failed because `clips.slug` is already taken, as opposed to anything
 * else. D1 reports it as `UNIQUE constraint failed: clips.slug` and drizzle wraps that in a
 * `DrizzleQueryError` whose `cause` carries the text, so the whole chain is searched rather than
 * just the top-level message. Naming the column, not merely "UNIQUE", keeps this from swallowing
 * a future constraint on some other column as though it were a slug collision.
 */
const isSlugCollision = (error: Error): boolean => {
  let current: Error | undefined = error
  // Bounded rather than "walk until the chain ends": a `cause` that points back at its own error
  // is malformed, not impossible, and this loop is in a request path.
  for (let depth = 0; current !== undefined && depth < 5; depth += 1) {
    if (current.message.includes('UNIQUE constraint failed: clips.slug')) {
      return true
    }
    current = current.cause instanceof Error ? current.cause : undefined
  }
  return false
}

type ClipRow = typeof clipsTable.$inferSelect

/**
 * D1 returns SQL `NULL` for absent optional columns; valibot's `v.optional` only recognizes
 * `undefined` as "absent", so a nullable column read straight back would fail its own schema.
 * Named field-by-field, rather than a generic key/value walk, so TypeScript checks each
 * conversion against the real column type instead of the walk being cast into shape.
 */
const nullsToUndefined = (row: ClipRow) => ({
  ...row,
  density: row.density ?? undefined,
  derivedFrom: row.derivedFrom ?? undefined,
  description: row.description ?? undefined,
  energy: row.energy ?? undefined,
  generator: row.generator ?? undefined,
  layerHint: row.layerHint ?? undefined,
  motion: row.motion ?? undefined,
  palette: row.palette ?? undefined,
  sourceUrl: row.sourceUrl ?? undefined,
  tags: row.tags ?? undefined,
  thumbnailKey: row.thumbnailKey ?? undefined,
})

/**
 * §5's "Automatic annotation (editable by a human)" fields, and only those — a `strictObject` so
 * `id`, `origin`, `deps`, `isolated` (and everything else the server owns) is a 400 here too, the
 * same rejection POST gives a client-supplied `id` rather than silently dropping the field.
 */
const clipPatchSchema = v.strictObject({
  defaultBars: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
  density: v.optional(clipDensitySchema),
  description: v.optional(v.string()),
  energy: v.optional(clipEnergySchema),
  layerHint: v.optional(clipLayerHintSchema),
  motion: v.optional(clipMotionSchema),
  palette: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
  tags: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
})

export const clipsRoutes = new Hono<{ Bindings: Env }>()
  .post('/', vValidator('json', newClipSchema), async (c) => {
    const body = c.req.valid('json')
    const id = crypto.randomUUID()
    const originalCode = body.code
    const code = normalizeHydra(body.code)

    // The same refusal `probeClip` makes in the browser, made here as well — counted by the same
    // scanner (`countOutCalls`), worded by the same message. §6.1 gives the compositor all four
    // Hydra buffers and a clip exactly one of them, and `rewriteOut` leaves a two-`.out(` clip
    // completely unrewritten, so such a clip would write another slot's buffer at playback with
    // no error anywhere. A gate that lives only in the registration screen is a suggestion; this
    // is the one the library's consumers can rely on.
    //
    // Deliberately NOT scoped to `engine === 'hydra'`, unlike the dependency analysis below. The
    // consumer makes no such distinction: `output-client.ts`'s `onLoad` hands ANY clip's code to
    // `HydraCompositor.load` with no engine branch at all, so an `isf`-labelled clip with two
    // `.out(` calls would write another slot's buffer exactly as a hydra one would. A guard that
    // trusts a field its consumer ignores is not a guard. If a future engine genuinely has
    // different output rules, this is the right place to find that out — by refusing it loudly —
    // rather than the place to exempt it in advance.
    if (countOutCalls(code) > 1) {
      return c.text(MULTI_OUTPUT_MESSAGE, 400)
    }
    // Ingestion only analyzes Hydra this milestone (§11.1); other engines get the empty deps
    // baseline rather than a guess, and are never isolated by inference.
    const { isolated, ...deps } =
      body.engine === 'hydra' ? analyzeHydra(code) : { ...EMPTY_DEPS, isolated: false }
    const slug = body.slug ?? slugify(body.engine, body.title, id)

    const row: Clip = v.parse(clipSchema, {
      ...body,
      annotationStatus: 'pending',
      code,
      deps,
      id,
      isolated,
      originalCode,
      params: [],
      reviewed: false,
      slug,
    })

    const db = drizzle(c.env.DB)
    try {
      await db.insert(clipsTable).values(row)
    } catch (error) {
      // `clips.slug` is UNIQUE and the registration form offers a slug field, so this is a
      // refusal a registrant reaches by typing — and the one registration failure whose cure is a
      // specific edit. It surfaced as an opaque 500 from the constraint; it is a 409 naming the
      // slug that is taken, like every other refusal this route makes.
      if (error instanceof Error && isSlugCollision(error)) {
        return c.text(
          `Slug "${slug}" is already taken by another clip. Choose a different slug, or leave the field empty and one will be generated.`,
          409,
        )
      }
      throw error
    }

    // Annotation is asynchronous and MUST NOT block registration (§0 principle 2, §11.1): the row
    // is already stored and already `annotationStatus: 'pending'`, so a queue that is absent (local
    // mode, §15.3) or momentarily unavailable leaves a registered, un-annotated clip — the exact
    // state `pending` exists to describe — rather than failing a registration that has succeeded.
    try {
      await enqueueAnnotation(c.env.INGEST, id)
    } catch (error) {
      console.error(`clips: could not enqueue annotation for ${id}`, error)
    }

    return c.json(row, 201)
  })
  .get('/', async (c) => {
    const db = drizzle(c.env.DB)
    const engineParam = c.req.query('engine')
    const reviewedParam = c.req.query('reviewed')
    const tagParam = c.req.query('tag')

    // Absence means "no filter" and must keep working; a present-but-unparseable value is a 400
    // naming the parameter and what it accepts — silently dropping the condition would make
    // `?engine=hydraa` behave exactly like no filter at all and return the whole library, which
    // reads as success both in the library UI and to an API client.
    let engineFilter: Clip['engine'] | undefined
    if (engineParam !== undefined) {
      const parsed = v.safeParse(engineKindSchema, engineParam)
      if (!parsed.success) {
        return c.text(`engine must be one of "hydra", "textmode", "isf"; got "${engineParam}"`, 400)
      }
      engineFilter = parsed.output
    }

    let reviewedFilter: boolean | undefined
    if (reviewedParam !== undefined) {
      if (reviewedParam !== 'true' && reviewedParam !== 'false') {
        return c.text(`reviewed must be "true" or "false"; got "${reviewedParam}"`, 400)
      }
      reviewedFilter = reviewedParam === 'true'
    }

    // `tags` is a JSON array in a text column, so membership is asked of the array's elements
    // rather than of the text around them. The `LIKE '%"<tag>"%'` this replaces was a silent
    // wrong answer, not merely a loose one: `%` returned every tagged clip and `_eon` matched
    // `neon`, both with a 200, so a caller who believed they had filtered had not — exactly what
    // the 400 on an unparseable `engine` exists to prevent, one filter over. Escaping the two
    // wildcards would have fixed those two cases and left `LIKE` matching a tag as a substring of
    // a longer one; `json_each` answers the question the caller actually asked. A tag containing
    // a literal `%` or `_` is an ordinary tag here, because nothing is a pattern.
    //
    // `tags IS NOT NULL` is explicit: an unannotated clip's column is SQL NULL, and `json_each`
    // is not owed an opinion about what to do with that.
    const conditions = [
      engineFilter === undefined ? undefined : eq(clipsTable.engine, engineFilter),
      reviewedFilter === undefined ? undefined : eq(clipsTable.reviewed, reviewedFilter),
      tagParam === undefined
        ? undefined
        : sql`${clipsTable.tags} is not null and exists (select 1 from json_each(${clipsTable.tags}) where json_each.value = ${tagParam})`,
    ].filter((condition) => condition !== undefined)

    const rows = await db
      .select()
      .from(clipsTable)
      .where(conditions.length > 0 ? and(...conditions) : undefined)

    const clips = rows.map((row) => v.parse(clipSummarySchema, nullsToUndefined(row)))
    return c.json({ clips })
  })
  .get('/:id', async (c) => {
    const db = drizzle(c.env.DB)
    const [row] = await db
      .select()
      .from(clipsTable)
      .where(eq(clipsTable.id, c.req.param('id')))

    if (row === undefined) {
      return c.text('Not Found', 404)
    }

    return c.json(v.parse(clipSchema, nullsToUndefined(row)))
  })
  .patch('/:id', vValidator('json', clipPatchSchema), async (c) => {
    const db = drizzle(c.env.DB)
    const id = c.req.param('id')
    const patch = c.req.valid('json')

    const [existing] = await db.select().from(clipsTable).where(eq(clipsTable.id, id))
    if (existing === undefined) {
      return c.text('Not Found', 404)
    }

    // Every field of `clipPatchSchema` is optional, so `{}` validates — and drizzle's
    // `set({})` throws "No values to set", which reached the caller as a 500. An empty patch is
    // not a failure, it is a request that changes nothing: skip the write and answer with the
    // clip as it stands, which is what `PATCH /api/tracks/:id` already does with its own
    // statement list.
    if (Object.keys(patch).length > 0) {
      await db.update(clipsTable).set(patch).where(eq(clipsTable.id, id))
    }
    const [updated] = await db.select().from(clipsTable).where(eq(clipsTable.id, id))
    if (updated === undefined) {
      return c.text('Not Found', 404)
    }

    return c.json(v.parse(clipSchema, nullsToUndefined(updated)))
  })
