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
      // While a fade is running there is nowhere to stage a change without
      // disturbing the buffer it is blending into (M1 has exactly two clip
      // buffers, o1/o2) — so queueing is refused outright, not redirected.
      if (state.fading) {
        return state
      }
      // The queued clip always takes the buffer the current one is not using.
      return { ...state, next: { clipId: event.clipId, slot: other(state.current.slot) } }
    }

    case 'go': {
      // A running fade is already committed to its own destination; arming a
      // second switch on top of it is refused, the same as `select-next`
      // above and `set-transition` below.
      if (!state.next || state.firing || state.fading) {
        return state
      }

      return { ...state, firing: { at: nextBarAt(clock, event.now) } }
    }

    case 'set-transition': {
      // Changing the transition mid-fade would either end the running fade
      // early (its own `bars` is what `tick` measures the span against) or
      // desync the control from what the output is actually blending — both
      // are refused. Before a fade starts (armed via Go but not yet fading)
      // this is still allowed: `go` already re-publishes with the new kind.
      if (state.fading) {
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
      if (!state.next) {
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
