// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Clock, PlaybackState } from '@vev/engines'
import { barDurationMs, barPhase, bpmFromTaps, FIXTURES, initialPlayback, reduce } from '@vev/engines'
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

/** A clip the panel can actually put on screen. `code` is what a `load` message carries; the panel never fetches it itself. */
export interface PlayableClip {
  readonly code: string
  readonly id: string
  readonly title: string
}

/**
 * One item of a track, resolved: which clip, how many bars it holds the screen for before
 * auto-advance fires (spec §7), and the transition that brings it in. Both fallbacks in spec §5
 * (`bars` defaults to the clip's `defaultBars`, `transitionIn` to the track's `defaultTransition`)
 * are already applied by the time a step gets here — see `resolveTrack` in `$lib/track-editor.ts`.
 */
export interface TrackStep {
  readonly bars: number
  readonly clipId: string
  readonly transition: TransitionSpec
}

/** A saved track with every clip it needs already fetched, ready to play. */
export interface LoadedTrack {
  readonly clips: readonly PlayableClip[]
  readonly id: string
  readonly steps: readonly TrackStep[]
  readonly title: string
}

/** Where the panel is in the loaded track. Read-only: every field is derived from the reducer's state or from the track itself. */
export interface TrackSnapshot {
  /** Spec §7: "Auto-advance can be toggled. When off, A keeps playing until Go." */
  autoAdvance: boolean
  /** The step on screen, or -1 before the first one has landed. */
  index: number
  length: number
  /** The step staged as `next`, or equal to `index` when nothing is staged — which is how the end of a track reads. */
  queued: number
  title: string
}

export interface ControlSnapshot {
  barPhase: number
  beatsPerBar: number
  bpm: number
  current: Loaded
  /** True while a crossfade is running. `go`, `queue` and `setTransitionKind` are all refused during it; `goNow` is not refused — it finishes the fade immediately instead. See `playback.ts`'s `fading` guards. */
  fading: boolean
  next: Loaded | undefined
  /** The loaded track, or `undefined` when the panel is not playing one. */
  track: TrackSnapshot | undefined
  transitionKind: TransitionKind
}

export interface CreateControlOptions {
  /** Every clip the panel may put on screen, by id. Defaults to `FIXTURES`; `loadTrack` adds a track's own clips to whatever is here. */
  clips?: readonly PlayableClip[]
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
  /** Fires the queued clip on the next bar. Does nothing if nothing is queued, Go is already armed, or a fade is running. */
  go: () => void
  /** Fires the queued clip immediately, or — mid-fade — finishes that fade immediately. Does nothing if neither applies. */
  goNow: () => void
  /** Forgets the loaded track. What is on screen keeps playing — §0: never stop the show. */
  clearTrack: () => void
  /** Loads a resolved track and stages its first step. Refused while a fade is running, the same as `queue`. */
  loadTrack: (track: LoadedTrack) => void
  /** Queues `clipId` into the free slot, publishing a `load` for it. Refused while a fade is running. Clears any loaded track — see its doc comment. */
  queue: (clipId: string) => void
  /** Turns auto-advance on or off (spec §7). With it off, the next step stays staged and waits for Go. */
  setAutoAdvance: (on: boolean) => void
  /** Sets the transition Go/Go now will arm next. Refused while a fade is running — it would either end the running fade early or desync it from what the output is blending. */
  setTransitionKind: (kind: TransitionKind) => void
  subscribe: (listener: (snapshot: ControlSnapshot) => void) => () => void
  /** Records a tap; once enough taps have accumulated, updates and publishes the tempo. */
  tap: () => void
  /** Advances local timers (fade completion, the bar-phase readout). Call from a frame loop. */
  tick: () => void
}

const transitionFor = (kind: TransitionKind): TransitionSpec => (kind === 'cut' ? CUT : CROSSFADE)

/**
 * The track cursor. Everything about what is playing still lives in `PlaybackState` — the reducer
 * stays the one source of truth (ADR 0004) and this adds no second one. All this records is WHICH
 * STEP the reducer's `current` corresponds to, and the moment that step landed, so auto-advance
 * can measure the step's `bars` from the bar it actually started on.
 */
interface TrackRun {
  /** The `at` of the switch currently armed, kept so `startedAt` is the bar the step LANDED on, not the tick that noticed. */
  armedAt: number | undefined
  autoAdvance: boolean
  /** The step on screen, or -1 before the first one has landed. */
  index: number
  /** The slot the staged step was loaded into: how a landing is detected, since two steps may name the same clip. */
  pendingSlot: Slot | undefined
  /** The step staged as `next`; equal to `index` when nothing is staged. */
  queued: number
  startedAt: number | undefined
  track: LoadedTrack
}

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
  const clipsById = new Map<string, PlayableClip>((options.clips ?? FIXTURES).map((clip) => [clip.id, clip]))

  let run: TrackRun | undefined

  const snapshot = (): ControlSnapshot => ({
    barPhase: barPhase(clock, now()),
    beatsPerBar: clock.beatsPerBar,
    bpm: clock.bpm,
    current: state.current,
    fading: state.fading !== undefined,
    next: state.next,
    track:
      run === undefined
        ? undefined
        : {
            autoAdvance: run.autoAdvance,
            index: run.index,
            length: run.track.steps.length,
            queued: run.queued,
            title: run.track.title,
          },
    transitionKind: state.transition.kind,
  })

  const notify = (): void => {
    const current = snapshot()
    for (const listener of listeners) {
      listener(current)
    }
  }

  const publishLoad = (loaded: Loaded): void => {
    const clip = clipsById.get(loaded.clipId)
    if (!clip) {
      return
    }

    publish({ clip: { code: clip.code, id: clip.id }, kind: 'load', slot: loaded.slot })
  }

  const publishClock = (): void => {
    publish({ beatsPerBar: clock.beatsPerBar, bpm: clock.bpm, downbeatAt: clock.downbeatAt, kind: 'clock' })
  }

  const queue = (clipId: string): void => {
    if (!clipsById.has(clipId)) {
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

    // A manual pick that the reducer ACCEPTED leaves the track. The alternative — keeping the
    // cursor and letting the next tick re-stage the track's own step over the top — would make
    // the manual pick vanish a frame after the press, which is exactly the silent swallow the M1
    // `fading` rulings exist to forbid. Picking the track again resumes it from its first step.
    //
    // Gated on the reducer having actually done something (`reduce` returns the state object
    // unchanged when it refuses), so a press refused mid-fade does not quietly drop the track
    // as a side effect of a control that visibly did nothing.
    if (state !== before) {
      run = undefined
    }
    notify()
  }

  const go = (): void => {
    const before = state
    state = reduce(state, { kind: 'go', now: now() }, clock)
    if (newlyArmed(before, state) && state.firing && state.next) {
      publish({ at: state.firing.at, kind: 'switch', to: state.next.slot, transition: state.transition })
      // The bar this switch lands on is what a track step's `bars` is measured from — not the tick
      // that later notices the switch completed. Measuring from the tick would let a crossfade's
      // own duration be charged to every step, and the track would drift later and later.
      if (run) {
        run.armedAt = state.firing.at
      }
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
      if (run) {
        run.armedAt = state.firing.at
      }
    }
    notify()
  }

  const setTransitionKind = (kind: TransitionKind): void => {
    const transition = transitionFor(kind)
    // `reduce` refuses this outright while a fade is running (see
    // `playback.ts`'s `set-transition` case) — `state.transition` then comes
    // back unchanged and nothing below fires, so the panel neither ends the
    // running fade early nor desyncs from what the output is blending.
    state = reduce(state, { kind: 'set-transition', transition }, clock)

    // A performer changing their mind between Go and the bar landing is
    // legitimate — the surface that would forbid it (locking the toggle
    // once armed) is worse than the one that re-publishes. The already-sent
    // `switch` carried the old transition; without this, the panel would
    // show the new kind while the output window executes the old one.
    // Re-publishing with the *same* `at` relies on the output side
    // superseding cleanly, not queuing behind or double-applying — see
    // `output-client.ts`'s `startOutput` doc comment.
    if (state.firing && state.next) {
      publish({ at: state.firing.at, kind: 'switch', to: state.next.slot, transition: state.transition })
    }
    notify()
  }

  /**
   * Stages the step after the one on screen: applies its transition and queues its clip, both
   * through `reduce`, so a running fade refuses both exactly as it refuses a manual `queue` and a
   * manual transition change. A refusal here is not an error and is not surfaced — it is retried
   * on the next `tick`, which is the whole difference between the panel's own controls (a person
   * pressed them, so a refusal must be visible) and the track's internal book-keeping (nobody
   * pressed anything, and the step lands a frame later).
   */
  const stageNextStep = (): void => {
    if (run === undefined || run.queued !== run.index) {
      return
    }

    const next = run.index + 1
    const step = run.track.steps[next]
    if (step === undefined) {
      // The track has run out. What is on screen keeps playing — §0: never stop the show.
      return
    }

    state = reduce(state, { kind: 'set-transition', transition: step.transition }, clock)
    const before = state
    state = reduce(state, { clipId: step.clipId, kind: 'select-next' }, clock)

    const staged = state.next
    if (staged === undefined || staged.clipId !== step.clipId) {
      return
    }
    if (before.next?.clipId !== staged.clipId || before.next.slot !== staged.slot) {
      publishLoad(staged)
    }

    // A switch may ALREADY be armed and already published — a manual Go, then a track loaded
    // before that Go's bar lands. The `set-transition` above is accepted by the reducer in that
    // window, so without this the panel would say the step's transition while the output window
    // executes whichever one the earlier `switch` carried. `setTransitionKind` re-publishes for
    // exactly this reason; so does this. Same `at` and same slot — only the transition changed.
    if (state.firing) {
      publish({ at: state.firing.at, kind: 'switch', to: staged.slot, transition: state.transition })
    }

    run.queued = next
    run.pendingSlot = staged.slot
  }

  /**
   * Notices that the staged step has landed, by the SLOT it was loaded into rather than by its
   * clip id: a track may legitimately name the same clip twice in a row, and comparing ids would
   * then read the switch as having already happened before it did. The reducer alternates slots on
   * every queue, so the slot is unambiguous.
   */
  const noticeLanding = (): void => {
    if (run === undefined || run.pendingSlot === undefined) {
      return
    }
    if (state.next !== undefined || state.current.slot !== run.pendingSlot) {
      return
    }

    run.index = run.queued
    run.startedAt = run.armedAt ?? now()
    run.armedAt = undefined
    run.pendingSlot = undefined
  }

  /**
   * Fires Go on the panel's behalf once the step on screen has used up its `bars` (spec §7: "A has
   * used up its bars (auto-advance)").
   *
   * No new timing lives here. `go` arms at `nextBarAt`, so arming one bar before the target puts
   * the switch on exactly the bar `bars` bars after the step started; `barDurationMs` and
   * `nextBarAt` are `@vev/engines`'s and are used unchanged.
   *
   * A step whose `bars` is no longer than the transition bringing the NEXT one in would come due
   * while that fade is still running, and `reduce` refuses `go` outright then. That is not
   * swallowed: this simply comes back on the following tick, and the step lands late rather than
   * being skipped.
   */
  const autoAdvanceIfDue = (): void => {
    if (run === undefined || !run.autoAdvance || run.queued === run.index) {
      return
    }

    const step = run.track.steps[run.index]
    if (step === undefined || run.startedAt === undefined) {
      return
    }
    if (state.firing !== undefined || state.fading !== undefined) {
      return
    }

    const bar = barDurationMs(clock.bpm, clock.beatsPerBar)
    if (now() >= run.startedAt + bar * step.bars - bar) {
      go()
    }
  }

  const loadTrack = (track: LoadedTrack): void => {
    // Refused while a fade is running, for the same reason `queue` is: with two clip buffers there
    // is nowhere to stage a change without disturbing the one the fade is blending into. The panel
    // disables the track selector while `fading` and says why, so this refusal is visible.
    if (state.fading) {
      return
    }

    for (const clip of track.clips) {
      clipsById.set(clip.id, clip)
    }
    run = {
      armedAt: undefined,
      autoAdvance: true,
      index: -1,
      pendingSlot: undefined,
      queued: -1,
      startedAt: undefined,
      track,
    }
    stageNextStep()
    notify()
  }

  const clearTrack = (): void => {
    run = undefined
    notify()
  }

  const setAutoAdvance = (on: boolean): void => {
    if (run === undefined) {
      return
    }

    run.autoAdvance = on
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
    noticeLanding()
    // Retried every tick rather than only on a landing: both `select-next` and `set-transition`
    // are refused while a fade is running, so the first attempt after a landing can legitimately
    // do nothing.
    stageNextStep()
    autoAdvanceIfDue()
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
    clearTrack,
    getSnapshot: snapshot,
    go,
    goNow,
    handleHello,
    loadTrack,
    queue,
    setAutoAdvance,
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
