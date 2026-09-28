// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Slot, TransitionSpec } from '@vev/shared'

import { barDurationMs, nextBarAt } from './clock.ts'
import type { Clock } from './clock.ts'

interface Loaded {
  clipId: string
  slot: Slot
}

export interface PlaybackState {
  current: Loaded
  next?: Loaded
  transition: TransitionSpec
  /** Set once Go is armed: the wall-clock moment the switch begins. */
  firing?: { at: number }
  /** Set while a crossfade is running; absent for a cut, which completes instantly. */
  fading?: { from: Slot; to: Slot; startedAt: number }
}

export type PlaybackEvent =
  | { kind: 'select-next'; clipId: string }
  | { kind: 'go'; now: number }
  | { kind: 'go-now'; now: number }
  | { kind: 'set-transition'; transition: TransitionSpec }
  | { kind: 'tick'; now: number }

export const initialPlayback = (clipId: string, transition: TransitionSpec): PlaybackState => ({
  current: { clipId, slot: 'a' },
  transition,
})

const other = (slot: Slot): Slot => (slot === 'a' ? 'b' : 'a')

/**
 * When each control is legal, as ONE definition that `reduce` itself uses.
 *
 * These exist because a panel that re-derives "is Go legal?" from its own reading of the state is
 * a second implementation of a rule this module owns, and the two drift. In M1 they drifted three
 * times, and the ruling that came out of it named only the fade — so a panel guarding on `fading`
 * alone still offered Go with nothing queued, and still offered it after Go was already armed.
 * The fix is not another guard in the panel; it is that there is only one predicate, exported, and
 * `reduce`'s own guards are written in terms of it. A control the reducer refuses is exactly a
 * control the UI must disable, by construction rather than by agreement.
 */

/** Go is legal only with something queued, nothing already armed, and no fade running. */
export const canGo = (state: PlaybackState): boolean =>
  state.next !== undefined && state.firing === undefined && state.fading === undefined

/**
 * Go now is legal mid-fade — it finishes the fade rather than doing nothing, which is why it is
 * the one control that stays enabled while every other is refused — and otherwise needs something
 * queued.
 */
export const canGoNow = (state: PlaybackState): boolean =>
  state.fading !== undefined || state.next !== undefined

/** With two clip buffers there is nowhere to stage a change into while a fade blends one of them. */
export const canQueue = (state: PlaybackState): boolean => state.fading === undefined

/** Changing the transition mid-fade would either cut the fade short or desync it from the output. */
export const canSetTransition = (state: PlaybackState): boolean => state.fading === undefined

/** The queued clip becomes the current one; both the armed moment and the fade are spent. */
const complete = (state: PlaybackState): PlaybackState => {
  if (!state.next) {
    return { ...state, fading: undefined, firing: undefined }
  }

  return { current: state.next, transition: state.transition }
}

const tick = (state: PlaybackState, now: number, clock: Clock): PlaybackState => {
  if (state.fading) {
    const span = barDurationMs(clock.bpm, clock.beatsPerBar) * state.transition.bars
    if (now < state.fading.startedAt + span) {
      return state
    }

    return complete(state)
  }

  if (!state.firing || now < state.firing.at) {
    return state
  }
  if (state.transition.kind === 'cut' || state.transition.bars === 0) {
    return complete(state)
  }

  return {
    ...state,
    fading: { from: state.current.slot, startedAt: state.firing.at, to: other(state.current.slot) },
    firing: undefined,
  }
}

export const reduce = (state: PlaybackState, event: PlaybackEvent, clock: Clock): PlaybackState => {
  switch (event.kind) {
    case 'select-next': {
      // The refusal lives in `canQueue`, not here — see its doc comment: one predicate, used both
      // by this reducer and by whatever surface offers the control.
      if (!canQueue(state)) {
        return state
      }
      // The queued clip always takes the buffer the current one is not using.
      return { ...state, next: { clipId: event.clipId, slot: other(state.current.slot) } }
    }

    case 'go': {
      // `canGo` is the whole rule: something queued, nothing already armed (a running fade is
      // already committed to its own destination), no fade in flight.
      if (!canGo(state)) {
        return state
      }

      return { ...state, firing: { at: nextBarAt(clock, event.now) } }
    }

    case 'set-transition': {
      // Refused mid-fade (`canSetTransition`): it would either end the running fade early — its
      // own `bars` is what `tick` measures the span against — or desync the control from what the
      // output is actually blending. Before a fade starts (armed via Go but not yet fading) this
      // is still allowed: `go` already re-publishes with the new kind.
      if (!canSetTransition(state)) {
        return state
      }

      return { ...state, transition: event.transition }
    }

    case 'go-now': {
      // Mid-fade, "now" means finish it — a press that did nothing would be a silent
      // swallow, and the performer would press it again into a show that ignores them.
      if (state.fading) {
        return complete(state)
      }
      if (!canGoNow(state)) {
        return state
      }

      return { ...state, firing: { at: event.now } }
    }

    case 'tick': {
      return tick(state, event.now, clock)
    }

    default: {
      return state
    }
  }
}
