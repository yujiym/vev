// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ClipEnergy, EngineKind, TransitionKind, TransitionSpec } from '@vev/shared'

/** A cut is the bar-start swap itself, so it has no duration (spec §9.1). */
const CUT: TransitionSpec = { bars: 0, kind: 'cut' }

const crossfade = (bars: number): TransitionSpec => ({ bars, kind: 'crossfade' })

export interface TransitionInput {
  readonly current: { readonly energy?: ClipEnergy; readonly engine: EngineKind }
  /** The track's default when the rules have nothing to say (spec §9.2 step 4). */
  readonly defaultTransition: TransitionSpec
  /** The performer's own choice for this switch; it outranks every automatic rule (step 1). */
  readonly explicit?: TransitionSpec
  /** The track item's locked transition (`TrackItem.transitionLocked`): never chosen automatically. */
  readonly locked?: TransitionSpec
  readonly next: {
    readonly energy?: ClipEnergy
    readonly engine: EngineKind
    readonly usesFeedback: boolean
  }
  readonly nextSection?: string
  /** The transitions actually used, most recent last; three in a row is what the variety rule looks for. */
  readonly recent?: readonly TransitionKind[]
}

const energyDelta = (input: TransitionInput): number | undefined =>
  input.current.energy === undefined || input.next.energy === undefined
    ? undefined
    : input.next.energy - input.current.energy

/**
 * Spec §9.2's rules, in its order, mapped onto the transition types the compositor can render.
 *
 * The mapping is the part worth stating plainly. `packages/shared`'s `TransitionSpec` allows only
 * `cut` and `crossfade` — the two `HydraCompositor` implements — while §9.1 names seven. Each rule
 * whose answer is not one of the two is mapped to the closest one that exists:
 *
 * | §9.2 rule | §9.1 type | chosen here |
 * | --- | --- | --- |
 * | next section `peak`, or energy +2 | cut | `cut` |
 * | next section `break`, or energy −2 | crossfade 4 bars | `crossfade`, 4 bars |
 * | B uses feedback | cut | `cut` |
 * | engine changes | crossfade 1–2 bars | `crossfade`, 2 bars |
 * | into textmode | asciify | `crossfade`, 2 bars (the engine-change rule) |
 * | same engine, energy within ±1 | modulate 1 bar | `crossfade`, 1 bar |
 * | large brightness difference | luma | not decided: nothing measures brightness yet |
 *
 * That is not a shortcut around the missing types: a modulate, a luma or an asciify has no
 * renderer, so returning one would produce a spec the compositor cannot play. The table above is
 * what changes when they arrive.
 */
const byRules = (input: TransitionInput): TransitionSpec => {
  const delta = energyDelta(input)

  if (input.nextSection === 'peak' || (delta !== undefined && delta >= 2)) {
    return CUT
  }
  if (input.nextSection === 'break' || (delta !== undefined && delta <= -2)) {
    return crossfade(4)
  }
  if (input.next.usesFeedback) {
    return CUT
  }
  if (input.next.engine !== input.current.engine) {
    return crossfade(2)
  }
  if (delta !== undefined && Math.abs(delta) <= 1) {
    return crossfade(1)
  }
  return input.defaultTransition
}

/** The other kind available today, with a duration that suits it: a cut has none, a crossfade needs one. */
const alternative = (kind: TransitionKind): TransitionSpec => (kind === 'cut' ? crossfade(2) : CUT)

/**
 * Spec §9.2's last line: three identical transitions in a row make the fourth different. A caller
 * that already holds a transition, such as one the decision response suggested, applies it here
 * because only the caller knows what was played.
 */
export const withVariety = (chosen: TransitionSpec, recent: readonly TransitionKind[]): TransitionSpec => {
  const lastThree = recent.slice(-3)
  const repeated = lastThree.length === 3 && lastThree.every((kind) => kind === chosen.kind)

  return repeated ? alternative(chosen.kind) : chosen
}

/**
 * Spec §9.2's automatic selection.
 *
 * Order: an explicit choice, then a locked transition, then the rules, and §9.2's last line — three
 * identical transitions in a row make the fourth different. The variety rule applies only to what
 * the rules chose (and to the track default): a human's explicit choice is not overridden to keep
 * a sequence interesting.
 */
export const chooseTransition = (input: TransitionInput): TransitionSpec => {
  if (input.explicit !== undefined) {
    return input.explicit
  }
  if (input.locked !== undefined) {
    return input.locked
  }

  return withVariety(byRules(input), input.recent ?? [])
}
