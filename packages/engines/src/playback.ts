// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PanicMode, Slot, TransitionSpec } from '@vev/shared'

import { barDurationMs, nextBarAt } from './clock.ts'
import type { Clock } from './clock.ts'

export type { PanicMode } from '@vev/shared'

interface Loaded {
  clipId: string
  slot: Slot
}

/** How many clips Back can walk through. A set is long; a stack that grows forever is a leak. */
const HISTORY_LIMIT = 20

export interface PlaybackState {
  current: Loaded
  next?: Loaded
  transition: TransitionSpec
  /** Set once Go is armed: the wall-clock moment the switch begins. */
  firing?: { at: number }
  /** Set while a crossfade is running; absent for a cut, which completes instantly. */
  fading?: { from: Slot; to: Slot; startedAt: number }
  /** Set by Hold: auto-advance is paused until the performer presses Go again (spec §7). */
  held?: boolean
  /**
   * The transition `current` actually arrived with: what the switch used when it landed, and a cut
   * for Back, whatever transition is set for the next switch. Absent until the first switch.
   */
  arrivedBy?: TransitionSpec
  /** Clips that were current before `current`, most recent last. Back consumes the end. */
  history?: readonly Loaded[]
  /** Output-wide panic state. Absent means normal. */
  panic?: PanicMode
}

export type PlaybackEvent =
  | { kind: 'select-next'; clipId: string }
  | { kind: 'go'; now: number }
  | { kind: 'go-now'; now: number }
  | { kind: 'set-transition'; transition: TransitionSpec }
  | { kind: 'hold' }
  | { kind: 'back' }
  | { kind: 'blackout' }
  | { kind: 'freeze' }
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

/** Back needs a previous clip to return to, and a fade already in flight would be interrupted. */
export const canBack = (state: PlaybackState): boolean =>
  state.fading === undefined && (state.history?.length ?? 0) > 0

/** Hold pauses auto-advance; it does not stop the clip already playing (spec §7). */
export const isHeld = (state: PlaybackState): boolean => state.held === true

/** What the output should do right now, panic-wise. */
export const panicMode = (state: PlaybackState): PanicMode => state.panic ?? 'none'

/** The queued clip becomes the current one; both the armed moment and the fade are spent. */
const complete = (state: PlaybackState): PlaybackState => {
  if (!state.next) {
    return { ...state, fading: undefined, firing: undefined }
  }

  const next: PlaybackState = {
    arrivedBy: state.transition,
    current: state.next,
    history: [...(state.history ?? []), state.current].slice(-HISTORY_LIMIT),
    transition: state.transition,
  }
  if (state.panic !== undefined) {
    next.panic = state.panic
  }
  if (state.held === true) {
    next.held = true
  }
  return next
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

/** Back returns through the free buffer, drops anything queued or armed, and keeps what is not about the clip (hold, panic). */
const back = (state: PlaybackState): PlaybackState => {
  // `canBack` is the whole rule: there is a previous clip, and no fade is in flight.
  const history = state.history ?? []
  const previous = history.at(-1)
  if (!canBack(state) || previous === undefined) {
    return state
  }

  // The control window re-loads the previous clip's code into that slot before asking the output to
  // cut to it, so a history deeper than the two buffers can still be walked.
  const returned: PlaybackState = {
    arrivedBy: { bars: 0, kind: 'cut' },
    current: { clipId: previous.clipId, slot: other(state.current.slot) },
    history: history.slice(0, -1),
    transition: state.transition,
  }
  if (state.held === true) {
    returned.held = true
  }
  if (state.panic !== undefined) {
    returned.panic = state.panic
  }
  return returned
}

const goNow = (state: PlaybackState, now: number): PlaybackState => {
  // Mid-fade, "now" means finish it — a press that did nothing would be a silent
  // swallow, and the performer would press it again into a show that ignores them.
  if (state.fading) {
    return { ...complete(state), held: false }
  }
  if (!canGoNow(state)) {
    return state
  }

  return { ...state, firing: { at: now }, held: false }
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

      // Pressing Go is an explicit advance, so it releases Hold rather than leaving the show
      // paused after the one switch the performer asked for.
      return { ...state, firing: { at: nextBarAt(clock, event.now) }, held: false }
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
      return goNow(state, event.now)
    }

    case 'hold': {
      return { ...state, held: state.held !== true }
    }

    case 'back': {
      return back(state)
    }

    case 'blackout': {
      return { ...state, panic: panicMode(state) === 'blackout' ? 'none' : 'blackout' }
    }

    case 'freeze': {
      return { ...state, panic: panicMode(state) === 'freeze' ? 'none' : 'freeze' }
    }

    case 'tick': {
      return tick(state, event.now, clock)
    }

    default: {
      return state
    }
  }
}
