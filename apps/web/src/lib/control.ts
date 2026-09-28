// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Clock, PlaybackState } from '@vev/engines'
import { barPhase, bpmFromTaps, FIXTURES, initialPlayback, reduce } from '@vev/engines'
import { OUTPUT_CHANNEL, outputMessageSchema } from '@vev/shared'
import type { OutputMessage, Slot, TransitionKind, TransitionSpec } from '@vev/shared'
import * as v from 'valibot'

/**
 * A tap arriving within this many milliseconds of its predecessor is treated
 * as a double-fire of the same physical tap (touch plus click, a key repeat)
 * rather than a second beat, and is dropped before it ever reaches
 * `bpmFromTaps` — that function has no way to tell a double-fire from a very
 * fast tempo, so the debounce belongs here, at the control where the
 * artifact originates.
 */
const TAP_DEBOUNCE_MS = 50

/** A tap sequence older than this is a new phrase, not a continuation of the last one. */
const TAP_RESET_MS = 2000

const CUT: TransitionSpec = { bars: 0, kind: 'cut' }
const CROSSFADE: TransitionSpec = { bars: 2, kind: 'crossfade' }

type Loaded = PlaybackState['current']

export interface ControlSnapshot {
  barPhase: number
  beatsPerBar: number
  bpm: number
  current: Loaded
  next: Loaded | undefined
  transitionKind: TransitionKind
}

export interface CreateControlOptions {
  /** Wall-clock now, per spec: `Date.now()`, never `performance.now()`. */
  now?: () => number
  /** The clip shown in slot `a` before anything is queued. Defaults to the second fixture. */
  startClipId?: string
}

export interface Control {
  /** Reads the current state; only for callers that don't need to react to changes. */
  getSnapshot: () => ControlSnapshot
  /** Publishes clock, load and switch messages that restore the output to what it's showing. Call on `hello`. */
  handleHello: () => void
  /** Fires the queued clip on the next bar. Does nothing if nothing is queued or Go is already armed. */
  go: () => void
  /** Fires the queued clip immediately, or — mid-fade — finishes that fade immediately. Does nothing if neither applies. */
  goNow: () => void
  /** Queues `clipId` into the free slot, publishing a `load` for it. */
  queue: (clipId: string) => void
  /** Sets the transition Go/Go now will arm next. */
  setTransitionKind: (kind: TransitionKind) => void
  subscribe: (listener: (snapshot: ControlSnapshot) => void) => () => void
  /** Records a tap; once enough taps have accumulated, updates and publishes the tempo. */
  tap: () => void
  /** Advances local timers (fade completion, the bar-phase readout). Call from a frame loop. */
  tick: () => void
}

const fixtureById = (clipId: string) => FIXTURES.find((fixture) => fixture.id === clipId)

const transitionFor = (kind: TransitionKind): TransitionSpec => (kind === 'cut' ? CUT : CROSSFADE)

/** True exactly when `before` had no armed switch and `after` does — the moment Go or Go now just armed one. */
const newlyArmed = (before: PlaybackState, after: PlaybackState): boolean =>
  !before.firing && after.firing !== undefined && after.next !== undefined

export const createControl = (
  publish: (message: OutputMessage) => void,
  options: CreateControlOptions = {},
): Control => {
  const now = options.now ?? Date.now
  const startClipId = options.startClipId ?? FIXTURES[1].id

  let clock: Clock = { beatsPerBar: 4, bpm: 120, downbeatAt: now() }
  let state: PlaybackState = initialPlayback(startClipId, CUT)
  let taps: number[] = []
  const listeners = new Set<(snapshot: ControlSnapshot) => void>()

  const snapshot = (): ControlSnapshot => ({
    barPhase: barPhase(clock, now()),
    beatsPerBar: clock.beatsPerBar,
    bpm: clock.bpm,
    current: state.current,
    next: state.next,
    transitionKind: state.transition.kind,
  })

  const notify = (): void => {
    const current = snapshot()
    for (const listener of listeners) {
      listener(current)
    }
  }

  const publishLoad = (loaded: Loaded): void => {
    const fixture = fixtureById(loaded.clipId)
    if (!fixture) {
      return
    }

    publish({ clip: { code: fixture.code, id: fixture.id }, kind: 'load', slot: loaded.slot })
  }

  const publishClock = (): void => {
    publish({ beatsPerBar: clock.beatsPerBar, bpm: clock.bpm, downbeatAt: clock.downbeatAt, kind: 'clock' })
  }

  const queue = (clipId: string): void => {
    if (!fixtureById(clipId)) {
      return
    }

    const before = state
    state = reduce(state, { clipId, kind: 'select-next' }, clock)
    const { next } = state
    const changed =
      next !== undefined && (before.next?.clipId !== next.clipId || before.next.slot !== next.slot)
    if (next && changed) {
      publishLoad(next)
    }
    notify()
  }

  const go = (): void => {
    const before = state
    state = reduce(state, { kind: 'go', now: now() }, clock)
    if (newlyArmed(before, state) && state.firing && state.next) {
      publish({ at: state.firing.at, kind: 'switch', to: state.next.slot, transition: state.transition })
    }
    notify()
  }

  const goNow = (): void => {
    const before = state
    const at = now()

    if (before.fading) {
      // Finishing a running fade snaps the output to its target immediately — a
      // press that did nothing here would silently swallow it (see playback.ts's
      // `go-now` case). The local reducer completes the switch outright, so the
      // output window is told the same thing: an instant cut to the fade's target.
      state = reduce(state, { kind: 'go-now', now: at }, clock)
      publish({ at, kind: 'switch', to: before.fading.to, transition: CUT })
      notify()
      return
    }

    state = reduce(state, { kind: 'go-now', now: at }, clock)
    if (newlyArmed(before, state) && state.firing && state.next) {
      publish({ at: state.firing.at, kind: 'switch', to: state.next.slot, transition: state.transition })
    }
    notify()
  }

  const setTransitionKind = (kind: TransitionKind): void => {
    const transition = transitionFor(kind)
    state = { ...state, transition }

    // A performer changing their mind between Go and the bar landing is
    // legitimate — the surface that would forbid it (locking the toggle
    // once armed) is worse than the one that re-publishes. The already-sent
    // `switch` carried the old transition; without this, the panel would
    // show the new kind while the output window executes the old one.
    // Re-publishing with the *same* `at` relies on the output side
    // superseding cleanly, not queuing behind or double-applying — see
    // `output-client.ts`'s `startOutput` doc comment.
    if (state.firing && state.next) {
      publish({ at: state.firing.at, kind: 'switch', to: state.next.slot, transition })
    }
    notify()
  }

  const tap = (): void => {
    const at = now()
    const last = taps.at(-1)

    if (last !== undefined && at - last < TAP_DEBOUNCE_MS) {
      return
    }

    taps = last !== undefined && at - last > TAP_RESET_MS ? [at] : [...taps, at]

    const bpm = bpmFromTaps(taps)
    if (bpm !== undefined) {
      clock = { ...clock, bpm, downbeatAt: at }
      publishClock()
    }
    notify()
  }

  const tick = (): void => {
    // Always notified, even when `state` itself doesn't change: the bar-phase
    // readout advances every tick regardless, since it's derived from `now()`.
    state = reduce(state, { kind: 'tick', now: now() }, clock)
    notify()
  }

  const handleHello = (): void => {
    const at = now()
    publishClock()

    const slots = new Map<Slot, Loaded>()
    slots.set(state.current.slot, state.current)
    if (state.next) {
      slots.set(state.next.slot, state.next)
    }
    for (const loaded of slots.values()) {
      publishLoad(loaded)
    }

    // Restores exactly what was showing before anything else — see this
    // message's doc comment in `@vev/shared`'s `output-channel.ts`.
    publish({ at, kind: 'switch', to: state.current.slot, transition: CUT })

    // The restore-cut above is not the whole story if a transition was
    // already under way: this window's reducer will still complete it
    // locally on its own next `tick()`, but nothing publishes that unless
    // it's done here too — a reloaded output window would otherwise sit on
    // `current` forever, out of sync with a control that thinks the switch
    // already happened. Progress is derived from a `switch` message's `at`,
    // not from accumulated deltas (see `output-channel.ts`'s doc comment),
    // so re-sending the *original* `at` — not `now` — restores the output
    // to the right point in the transition by construction: a fade re-sent
    // with its real `startedAt` resumes exactly where it should be, not at
    // 0%. The output side supersedes the restore-cut above with whichever
    // of these arrives, since both carry `startOutput`'s "latest wins"
    // pending-switch semantics.
    if (state.firing && state.next) {
      publish({ at: state.firing.at, kind: 'switch', to: state.next.slot, transition: state.transition })
    } else if (state.fading) {
      publish({
        at: state.fading.startedAt,
        kind: 'switch',
        to: state.fading.to,
        transition: state.transition,
      })
    }
  }

  return {
    getSnapshot: snapshot,
    go,
    goNow,
    handleHello,
    queue,
    setTransitionKind,
    subscribe: (listener) => {
      listeners.add(listener)
      listener(snapshot())
      return () => {
        listeners.delete(listener)
      }
    },
    tap,
    tick,
  }
}

export interface StartControlOptions extends CreateControlOptions {
  /** Cancels a handle returned by `requestFrame`. Defaults to `cancelAnimationFrame`. */
  cancelFrame?: (handle: number) => void
  /** Defaults to a fresh `BroadcastChannel(OUTPUT_CHANNEL)`, closed on teardown. */
  channel?: BroadcastChannel
  /** Schedules one frame. Defaults to `requestAnimationFrame`, ignoring its timestamp argument (`tick` uses `now()` instead, matching `startOutput`). */
  requestFrame?: (run: () => void) => number
}

export interface StartedControl {
  control: Control
  /** Unsubscribes the channel and stops the frame loop. */
  stop: () => void
}

/**
 * Wires a framework-free `Control` to the real world: a `BroadcastChannel`
 * for publishing and for answering `hello`, and a frame loop that drives
 * `tick` so the bar-phase readout and fade completion advance on their own.
 *
 * Kept here rather than in `+page.svelte`'s `$effect`, for the same reason
 * `startOutput` lives in `output-client.ts` and not in the output route:
 * `.svelte` is outside the type and lint gate (ADR 0001), and Task 4's own
 * defect (a resize handler that broke rendering) got in exactly where
 * nothing could check it. Every browser dependency here is an injectable,
 * defaulted option, so this function is tested the same way `startOutput` is
 * — no real DOM, no real channel.
 */
export const startControl = (options: StartControlOptions = {}): StartedControl => {
  const {
    cancelFrame = cancelAnimationFrame,
    channel = new BroadcastChannel(OUTPUT_CHANNEL),
    requestFrame = (run: () => void) =>
      requestAnimationFrame(() => {
        run()
      }),
    ...controlOptions
  } = options

  const control = createControl((message) => {
    // BroadcastChannel.postMessage takes a single argument — unlike
    // Window.postMessage, it has no `targetOrigin` parameter to require.
    // oxlint-disable-next-line unicorn/require-post-message-target-origin
    channel.postMessage(message)
  }, controlOptions)

  const onMessage = (event: MessageEvent): void => {
    try {
      const result = v.safeParse(outputMessageSchema, event.data)
      if (result.success && result.output.kind === 'hello') {
        control.handleHello()
      }
    } catch (error) {
      // A throw here must not kill the channel for the rest of the show.
      console.error('vev: control channel handler failed', error)
    }
  }
  channel.addEventListener('message', onMessage)

  let stopped = false
  let frame: number | undefined
  const loop = (): void => {
    if (stopped) {
      return
    }
    control.tick()
    frame = requestFrame(loop)
  }
  frame = requestFrame(loop)

  return {
    control,
    stop: () => {
      stopped = true
      channel.removeEventListener('message', onMessage)
      channel.close()
      if (frame !== undefined) {
        cancelFrame(frame)
        frame = undefined
      }
    },
  }
}
