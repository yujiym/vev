// SPDX-License-Identifier: AGPL-3.0-or-later
import { vValidator } from '@hono/valibot-validator'
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
import { and, eq, like } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import * as v from 'valibot'

import { clipsTable } from '../db/clips.ts'
import type { Env } from '../env.ts'

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
    await db.insert(clipsTable).values(row)

    return c.json(row, 201)
  })
  .get('/', async (c) => {
    const db = drizzle(c.env.DB)
    const engineParam = v.safeParse(engineKindSchema, c.req.query('engine'))
    const reviewedParam = c.req.query('reviewed')
    const tagParam = c.req.query('tag')

    const conditions = [
      engineParam.success ? eq(clipsTable.engine, engineParam.output) : undefined,
      reviewedParam === undefined ? undefined : eq(clipsTable.reviewed, reviewedParam === 'true'),
      tagParam === undefined ? undefined : like(clipsTable.tags, `%"${tagParam}"%`),
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

    await db.update(clipsTable).set(patch).where(eq(clipsTable.id, id))
    const [updated] = await db.select().from(clipsTable).where(eq(clipsTable.id, id))
    if (updated === undefined) {
      return c.text('Not Found', 404)
    }

    return c.json(v.parse(clipSchema, nullsToUndefined(updated)))
  })
