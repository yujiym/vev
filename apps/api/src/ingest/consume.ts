// SPDX-License-Identifier: AGPL-3.0-or-later
import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as v from 'valibot'

import { clipsTable } from '../db/clips.ts'
import type { Env } from '../env.ts'
import { annotateClip, withTimeout } from './annotate.ts'
import type { JevImage } from './jev.ts'

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
 *   and `maxRetries: 2` in `cloudflare.config.ts` bounds even that.
 */

/**
 * The queue message. `trigger` is what lets a clip with stills be annotated once: the registration
 * message waits long enough for the stills to arrive and then stands down if they already did.
 */
export const ingestMessageSchema = v.strictObject({
  clipId: v.pipe(v.string(), v.minLength(1)),
  trigger: v.picklist(['registered', 'stills']),
})

export type IngestMessage = v.InferOutput<typeof ingestMessageSchema>

/** How long a registered clip waits for its stills before it is annotated from its code alone. */
export const REGISTRATION_DELAY_SECONDS = 60

/**
 * Enqueues a clip for annotation. Void binds a working queue locally too, so local mode is refused
 * here: a venue has no model to answer, and registration must still succeed (§15.3).
 */
export const enqueueAnnotation = async (
  env: Pick<Env, 'QUEUE_INGEST' | 'VEV_MODE'>,
  clipId: string,
  trigger: IngestMessage['trigger'],
): Promise<void> => {
  if (env.VEV_MODE === 'local' || env.QUEUE_INGEST === undefined) {
    return
  }
  await env.QUEUE_INGEST.send(
    v.parse(ingestMessageSchema, { clipId, trigger }),
    trigger === 'registered' ? { delaySeconds: REGISTRATION_DELAY_SECONDS } : {},
  )
}

/** Marks a clip's annotation as failed WITHOUT touching any other column — see this file's header. */
const markFailed = async (env: Env, clipId: string): Promise<void> => {
  await drizzle(env.DB)
    .update(clipsTable)
    .set({ annotationStatus: 'failed' })
    .where(eq(clipsTable.id, clipId))
}

/** Reading a few small objects from R2 is quick; this bounds the case where it is not. */
const STILLS_LOAD_TIMEOUT_MS = 10_000

/**
 * The clip's stills, in recording order. Best effort by contract, like the stills upload that made
 * them: a missing object or an R2 failure drops that frame, and none left means the clip is
 * annotated from its code alone — which is also what a clip registered without stills gets.
 */
const loadStills = async (env: Env, clipId: string, keys: readonly string[]): Promise<JevImage[]> => {
  if (keys.length === 0) {
    return []
  }
  try {
    const objects = await withTimeout(
      Promise.all(
        keys.map(async (key) => {
          const object = await env.MEDIA.get(key)
          return object === null ? null : new Uint8Array(await object.arrayBuffer())
        }),
      ),
      STILLS_LOAD_TIMEOUT_MS,
      'loading stills',
    )
    return objects.flatMap((bytes) => (bytes === null ? [] : [{ bytes, format: 'jpeg' as const }]))
  } catch (error) {
    console.error(`ingest: clip ${clipId} stills could not be loaded, annotating from code alone`, error)
    return []
  }
}

const annotateOne = async (env: Env, clipId: string, trigger: IngestMessage['trigger']): Promise<void> => {
  const db = drizzle(env.DB)
  const [row] = await db
    .select({
      annotationStatus: clipsTable.annotationStatus,
      code: clipsTable.code,
      // `deps` is read for annotation too: two of a clip's tags are derived from it rather than
      // asked of a model (see `derivedTags`, `tags.ts`).
      deps: clipsTable.deps,
      engine: clipsTable.engine,
      stillKeys: clipsTable.stillKeys,
      title: clipsTable.title,
    })
    .from(clipsTable)
    .where(eq(clipsTable.id, clipId))

  if (row === undefined) {
    // Deleted between enqueue and consumption. Nothing to annotate and nothing to retry.
    console.error(`ingest: clip ${clipId} no longer exists`)
    return
  }

  if (trigger === 'registered' && row.annotationStatus !== 'pending') {
    return
  }

  if (env.AI === undefined) {
    console.error(`ingest: clip ${clipId} cannot be annotated — no AI binding in this environment`)
    await markFailed(env, clipId)
    return
  }

  const stills = await loadStills(env, clipId, row.stillKeys ?? [])
  const result = await annotateClip(env.AI, { ...row, stills })
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
    evidence: result.evidence,
    jevMs: result.jevMs,
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

type ConsumerMessage = Pick<Message, 'ack' | 'body' | 'retry'>

const handleMessage = async (message: ConsumerMessage, env: Env): Promise<void> => {
  const parsed = v.safeParse(ingestMessageSchema, message.body)
  if (!parsed.success) {
    console.error('ingest: dropping a message that is not an annotation request', message.body)
    message.ack()
    return
  }

  try {
    await annotateOne(env, parsed.output.clipId, parsed.output.trigger)
    message.ack()
  } catch (error) {
    // Reached only when D1 itself failed: `annotateClip` returns a result rather than throwing, so
    // an annotation that simply did not work has already been recorded as `failed` and acked above.
    console.error(`ingest: clip ${parsed.output.clipId} could not be stored`, error)
    message.retry()
  }
}

/** The annotation consumer, wired to Void in `queues/ingest.ts`. */
export const ingestQueue = async (
  batch: { readonly messages: readonly ConsumerMessage[] },
  env: Env,
): Promise<void> => {
  for (const message of batch.messages) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- annotation is one clip at a time (max_batch_size is 1) and each message writes to D1; running a batch concurrently would only add contention
    await handleMessage(message, env)
  }
}
