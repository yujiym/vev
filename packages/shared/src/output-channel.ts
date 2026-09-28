// SPDX-License-Identifier: AGPL-3.0-or-later
import * as v from 'valibot'

import { slotSchema, transitionSpecSchema } from './playback-types.ts'

/**
 * The control window holds the state and sends intents; the output window renders.
 *
 * Every moment in these messages is a `Date.now()` wall-clock millisecond, never
 * `performance.now()`: the two windows are separate documents with separate
 * performance origins, and only wall-clock values are comparable between them.
 * The output window derives transition progress from `at` itself, so a late or
 * dropped message cannot desynchronise the fade.
 */
export const OUTPUT_CHANNEL = 'vev:output'

const clipSchema = v.object({
  code: v.pipe(
    v.string(),
    v.minLength(1),
    v.check((s) => /\S/u.test(s), 'Must contain at least one non-whitespace character'),
  ),
  id: v.pipe(v.string(), v.minLength(1)),
})

export const outputMessageSchema = v.variant('kind', [
  /** Compile a clip into a buffer. Sent before the switch that needs it (spec §7). */
  v.object({ clip: clipSchema, kind: v.literal('load'), slot: slotSchema }),
  /** Begin a transition to `to` at wall-clock `at`. */
  v.object({
    at: v.number(),
    kind: v.literal('switch'),
    to: slotSchema,
    transition: transitionSpecSchema,
  }),
  /**
   * Sent by the OUTPUT window when it opens or reloads — the one message that travels
   * the other way. A projector that reloads mid-set otherwise shows black until the
   * next switch, which is a "never stop the show" failure (spec §0, principle 2). The
   * control window answers by re-sending `clock`, a `load` for each occupied slot, and
   * a `switch` to the current slot with `{ kind: 'cut', bars: 0 }` at `Date.now()`,
   * which restores the output to exactly what it was showing.
   */
  v.object({ kind: v.literal('hello') }),
  /** Tempo and downbeat, so the output window can derive bar phase itself. */
  v.object({
    beatsPerBar: v.pipe(v.number(), v.integer(), v.minValue(1)),
    bpm: v.pipe(v.number(), v.finite(), v.minValue(1)),
    downbeatAt: v.number(),
    kind: v.literal('clock'),
  }),
])

export type OutputMessage = v.InferOutput<typeof outputMessageSchema>
