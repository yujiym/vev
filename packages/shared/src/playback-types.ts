// SPDX-License-Identifier: AGPL-3.0-or-later
import * as v from 'valibot'

/** Which of the compositor's two clip buffers a clip occupies (spec §6.1: Hydra's o1 and o2). */
export const slotSchema = v.picklist(['a', 'b'])

/** M1 renders two of the transitions in spec §9.1; the rest arrive with later milestones. */
export const transitionSpecSchema = v.object({
  /** How long the transition takes. 0 is immediate, which is what a cut is. */
  bars: v.pipe(v.number(), v.minValue(0)),
  kind: v.picklist(['cut', 'crossfade']),
})

export type Slot = v.InferOutput<typeof slotSchema>
export type TransitionKind = TransitionSpec['kind']
export type TransitionSpec = v.InferOutput<typeof transitionSpecSchema>
