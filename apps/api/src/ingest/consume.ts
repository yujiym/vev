// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as v from 'valibot'

import { clipsTable } from '../db/clips.ts'
import type { Env } from '../env.ts'
import { annotateClip } from './annotate.ts'

/**
 * The annotation queue: what registration puts on it, and what the consumer does with it.
 *
 * Annotation is asynchronous because §0 principle 2 says it must never block registration, and
 * §11.1 puts it in a queue consumer because it is slow. That makes the failure modes, not the happy
 * path, the interesting part of this file:
 *
 * - A message that is not an annotation request is ACKED and dropped. It can never succeed, and a
 *   poison message retried forever is its own outage.
 * - Annotation failing (a malformed jev response, a refused call, no `AI` binding at all) writes
 *   `annotationStatus: 'failed'` and ACKS. The clip keeps every field it already had; nothing else
 *   on the row is touched.
 * - Only a STORAGE failure retries — D1 being unavailable is transient and worth another attempt —
 *   and `max_retries: 2` in `wrangler.jsonc` bounds even that.
 */

/** The queue message. One clip id; everything else the consumer reads from the row itself. */
export const ingestMessageSchema = v.strictObject({ clipId: v.pipe(v.string(), v.minLength(1)) })

export type IngestMessage = v.InferOutput<typeof ingestMessageSchema>

/**
 * Enqueues a clip for annotation, from the registration route.
 *
 * Takes the binding as `undefined`-able and does nothing when it is absent: local mode (§15.3) has
 * no queue, and registration must still work there. Parsed through the same schema the consumer
 * validates with, so producer and consumer cannot drift apart.
 */
export const enqueueAnnotation = async (queue: Queue | undefined, clipId: string): Promise<void> => {
  if (queue === undefined) {
    return
  }
  await queue.send(v.parse(ingestMessageSchema, { clipId }))
}

/** Marks a clip's annotation as failed WITHOUT touching any other column — see this file's header. */
const markFailed = async (env: Env, clipId: string): Promise<void> => {
  await drizzle(env.DB)
    .update(clipsTable)
    .set({ annotationStatus: 'failed' })
    .where(eq(clipsTable.id, clipId))
}

const annotateOne = async (env: Env, clipId: string): Promise<void> => {
  const db = drizzle(env.DB)
  const [row] = await db
    .select({
      code: clipsTable.code,
      // `deps` is read for annotation too: two of a clip's tags are derived from it rather than
      // asked of a model (see `derivedTags`, `tags.ts`).
      deps: clipsTable.deps,
      engine: clipsTable.engine,
      title: clipsTable.title,
    })
    .from(clipsTable)
    .where(eq(clipsTable.id, clipId))

  if (row === undefined) {
    // Deleted between enqueue and consumption. Nothing to annotate and nothing to retry.
    console.error(`ingest: clip ${clipId} no longer exists`)
    return
  }

  if (env.AI === undefined) {
    console.error(`ingest: clip ${clipId} cannot be annotated — no AI binding in this environment`)
    await markFailed(env, clipId)
    return
  }

  const result = await annotateClip(env.AI, row)
  if (!result.ok) {
    console.error(`ingest: clip ${clipId} annotation failed — ${result.reason}`)
    await markFailed(env, clipId)
    return
  }

  const { annotation } = result
  // The one place a successful annotation is observable from `wrangler tail`. It records how sure
  // jev was of each typed answer, which is the only signal available for whether the option
  // descriptions and the tag threshold are working — no column stores a confidence, and nothing
  // branches on one.
  console.log(`ingest: clip ${clipId} annotated`, {
    confidence: result.confidence,
    density: annotation.density,
    energy: annotation.energy,
    layerHint: annotation.layerHint,
    motion: annotation.motion,
    tags: annotation.tags,
  })
  await db
    .update(clipsTable)
    .set({
      annotationStatus: 'ok',
      density: annotation.density,
      description: annotation.description,
      energy: annotation.energy,
      layerHint: annotation.layerHint,
      motion: annotation.motion,
      tags: annotation.tags,
    })
    .where(eq(clipsTable.id, clipId))
}

const handleMessage = async (message: Message, env: Env): Promise<void> => {
  const parsed = v.safeParse(ingestMessageSchema, message.body)
  if (!parsed.success) {
    console.error('ingest: dropping a message that is not an annotation request', message.body)
    message.ack()
    return
  }

  try {
    await annotateOne(env, parsed.output.clipId)
    message.ack()
  } catch (error) {
    // Reached only when D1 itself failed: `annotateClip` returns a result rather than throwing, so
    // an annotation that simply did not work has already been recorded as `failed` and acked above.
    console.error(`ingest: clip ${parsed.output.clipId} could not be stored`, error)
    message.retry()
  }
}

/** The Worker's `queue()` handler (wired in `src/index.ts`). */
export const ingestQueue = async (batch: MessageBatch, env: Env): Promise<void> => {
  for (const message of batch.messages) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- annotation is one clip at a time (max_batch_size is 1) and each message writes to D1; running a batch concurrently would only add contention
    await handleMessage(message, env)
  }
}
