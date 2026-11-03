// SPDX-License-Identifier: AGPL-3.0-or-later
import type { PanicMode, Slot, TransitionSpec } from '@vev/shared'

import { barDurationMs, nextBarAt } from './clock.ts'
import type { Clock } from './clock.ts'

export type { PanicMode } from '@vev/shared'

interface Loaded {
  clipId: string
  slot: Slot
}

/**
 * A clip in the free slot. `ready` is false until that slot has rendered: Hydra samples a buffer
 * from before its own draw, so a cut straight after a load shows two frames of black, or of the
 * clip that slot last held (measured in a browser, ADR 0012). The renderer reports it with
 * `next-ready`, and `tick` will not fire without it.
 */
interface Staged extends Loaded {
  ready: boolean
}

/** How many clips Back can walk through. A set is long; a stack that grows forever is a leak. */
const HISTORY_LIMIT = 20

export interface PlaybackState {
  current: Loaded
  next?: Staged
  transition: TransitionSpec
  /**
   * Set once a switch is armed: the wall-clock moment it begins. `onBar` is what happens if it
   * cannot fire then: a bar-quantised switch slips to the following bar, a Go now waits for the
   * first frame it can fire on.
   */
  firing?: { at: number; onBar: boolean }
  /** Chosen during a fade, when the free slot is the fade's own target. Armed when the fade lands. */
  chosen?: string
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
  | { kind: 'choose'; clipId: string; now: number }
  | { kind: 'next-ready' }
  | { kind: 'unstage' }
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
    chosen: state.chosen,
    current: { clipId: state.next.clipId, slot: state.next.slot },
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

const staged = (state: PlaybackState, clipId: string): Staged =>
  state.next?.clipId === clipId ? state.next : { clipId, ready: false, slot: other(state.current.slot) }

/**
 * The performer's choice, in one rule per state. Armed already: the new clip takes the same bar.
 * Mid-fade: there is no free slot to stage into, so it waits for the landing rather than being lost.
 * Choosing is an explicit advance, so it releases Hold as Go does.
 */
const choose = (state: PlaybackState, clipId: string, now: number, clock: Clock): PlaybackState => {
  if (state.fading) {
    return { ...state, chosen: clipId, held: false }
  }

  return {
    ...state,
    firing: state.firing ?? { at: nextBarAt(clock, now), onBar: true },
    held: false,
    next: staged(state, clipId),
  }
}

/** What a landing does with a choice held through the fade. Choosing the clip that just landed asks for nothing. */
const armChosen = (state: PlaybackState, now: number, clock: Clock): PlaybackState => {
  const { chosen } = state
  const landed = { ...state, chosen: undefined }
  return chosen === undefined || chosen === state.current.clipId ? landed : choose(landed, chosen, now, clock)
}

const fireOrSlip = (state: PlaybackState, now: number, clock: Clock): PlaybackState => {
  const { firing, next } = state
  if (!firing || !next) {
    return state
  }
  // Freeze holds the switch as well as the picture, so the screen never names a clip nobody can see.
  if (!next.ready || panicMode(state) === 'freeze') {
    return firing.onBar ? { ...state, firing: { at: nextBarAt(clock, now), onBar: true } } : state
  }
  if (state.transition.kind === 'cut' || state.transition.bars === 0) {
    return complete(state)
  }

  return {
    ...state,
    fading: { from: state.current.slot, startedAt: firing.onBar ? firing.at : now, to: next.slot },
    firing: undefined,
  }
}

const tick = (state: PlaybackState, now: number, clock: Clock): PlaybackState => {
  if (state.fading) {
    const span = barDurationMs(clock.bpm, clock.beatsPerBar) * state.transition.bars
    return now < state.fading.startedAt + span ? state : armChosen(complete(state), now, clock)
  }

  return state.firing && now >= state.firing.at ? fireOrSlip(state, now, clock) : state
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

const goNow = (state: PlaybackState, now: number, clock: Clock): PlaybackState => {
  // Mid-fade, "now" means finish it — a press that did nothing would be a silent
  // swallow, and the performer would press it again into a show that ignores them.
  if (state.fading) {
    return { ...armChosen(complete(state), now, clock), held: false }
  }
  if (!canGoNow(state)) {
    return state
  }

  return { ...state, firing: { at: now, onBar: false }, held: false }
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
      return { ...state, next: staged(state, event.clipId) }
    }

    case 'choose': {
      return choose(state, event.clipId, event.now, clock)
    }

    case 'next-ready': {
      return state.next && !state.next.ready ? { ...state, next: { ...state.next, ready: true } } : state
    }

    case 'unstage': {
      return { ...state, firing: undefined, next: undefined }
    }

    case 'go': {
      // `canGo` is the whole rule: something queued, nothing already armed (a running fade is
      // already committed to its own destination), no fade in flight.
      if (!canGo(state)) {
        return state
      }

      // Pressing Go is an explicit advance, so it releases Hold rather than leaving the show
      // paused after the one switch the performer asked for.
      return { ...state, firing: { at: nextBarAt(clock, event.now), onBar: true }, held: false }
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
      return goNow(state, event.now, clock)
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
