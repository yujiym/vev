// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Clock, PanicMode, PlaybackEvent, PlaybackState } from '@vev/engines'
import {
  barDurationMs,
  barPhase,
  bpmFromTaps,
  canBack,
  canGo,
  canGoNow,
  canQueue,
  canSetTransition,
  FIXTURES,
  initialPlayback,
  isHeld,
  panicMode,
  reduce,
} from '@vev/engines'
import type { Slot, TransitionSpec } from '@vev/shared'

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

/**
 * Frames a freshly loaded slot must render before anything may cut to it. Hydra samples a buffer's
 * previous pass, so the first two frames after a load read black, or the clip the slot last held
 * (measured in a browser, ADR 0012).
 */
const READY_FRAMES = 2

/**
 * How often an uneventful frame tells subscribers. The picture and the screen share one thread now,
 * so the readouts that move every frame (bar phase, the countdown) do not get a render per frame.
 * Anything that changes state still notifies at once.
 */
const VIEW_INTERVAL_MS = 100

type Loaded = PlaybackState['current']

/**
 * What the control asks of the picture: `HydraCompositor` on the stage, a fake in tests. Every call
 * follows a decision the reducer has already made, on the frame it made it, so the picture holds no
 * schedule of its own and has nothing to disagree about (ADR 0004, ADR 0012).
 */
export interface Picture {
  /** Compiles a clip into a buffer. Throws when the code does not compile. */
  load: (slot: Slot, code: string) => void
  switchTo: (slot: Slot, spec: TransitionSpec, at: number) => void
  tick: (now: number) => void
}

/** A clip the control can actually put on screen. It never fetches code itself. */
export interface PlayableClip {
  readonly code: string
  readonly id: string
  readonly title: string
}

/**
 * One item of a track, resolved: which clip, how many bars it holds the screen for before
 * auto-advance fires (spec §7), and the transition that brings it in. Both fallbacks in spec §5
 * (`bars` defaults to the clip's `defaultBars`, `transitionIn` to the track's `defaultTransition`)
 * are already applied by the time a step gets here — see `resolveTrack` in `client/track-editor.ts`.
 */
export interface TrackStep {
  readonly bars: number
  readonly clipId: string
  /** The item's section label (`intro`, `peak`, …), when it has one — the timeline shows these. */
  readonly section?: string | undefined
  /** The clip's name, so the timeline can label a step with something a performer recognises. */
  readonly title?: string | undefined
  readonly transition: TransitionSpec
}

/** A saved track with every clip it needs already fetched, ready to play. */
export interface LoadedTrack {
  readonly clips: readonly PlayableClip[]
  readonly defaultTransition?: TransitionSpec
  readonly id: string
  readonly mode?: 'noncommercial' | 'commercial'
  readonly steps: readonly TrackStep[]
  readonly title: string
}

/** Where the show is in the loaded track. Read-only: every field is derived from the reducer's state or from the track itself. */
export interface TrackSnapshot {
  /** Spec §7: "Auto-advance can be toggled. When off, A keeps playing until Go." */
  autoAdvance: boolean
  /** How many bars the step on screen holds for. 0 before a track has landed one. */
  bars: number
  /**
   * Whole bars the step on screen has been playing. Clamped to `bars`, so a step that is due to
   * auto-advance reads 8/8 for the frame before it moves rather than 9/8.
   */
  elapsedBars: number
  /** The step on screen, or -1 before the first one has landed. */
  index: number
  length: number
  /** The step staged as `next`, or equal to `index` when nothing is staged — which is how the end of a track reads. */
  queued: number
  title: string
}

export interface ControlSnapshot {
  /** The transition the clip on screen actually arrived with (a cut for Back); `undefined` before the first switch. */
  arrivedBy: TransitionSpec | undefined
  /** True once Go (or Go now) has armed a switch that has not yet fired. A panel that showed only `fading` would look identical before and after a press whose bar has not landed. */
  armed: boolean
  barPhase: number
  beatsPerBar: number
  bpm: number
  /**
   * Whether each control is legal RIGHT NOW, straight from the reducer's own predicates
   * (`canGo` and friends in `@vev/engines`) rather than re-derived here from `fading`.
   *
   * This is the whole point of those predicates existing: a panel that works out for itself when
   * Go is allowed is a second implementation of a rule the reducer owns, and in M1 the two drifted
   * three times. A surface offering a control must disable it exactly when `reduce` would refuse
   * it — so it asks, instead of deciding. `canGoNow` is deliberately true mid-fade: that press
   * finishes the fade rather than doing nothing.
   */
  canGo: boolean
  canGoNow: boolean
  canQueue: boolean
  canSetTransition: boolean
  /** Whether Back has a previous clip to return to, from the reducer's own predicate. */
  canBack: boolean
  /** A choice held through a running fade, armed when it lands. */
  chosenClipId: string | undefined
  /** The source of the clip on screen, for the code overlay. */
  code: string | undefined
  current: Loaded
  /** The clip on screen, by name. `undefined` only for a start clip the control was never given — an id is not a name, and a UUID on stage tells the performer nothing. */
  currentTitle: string | undefined
  /** True while a crossfade is running. `go`, `stage` and `setTransition` are all refused during it; `goNow` finishes the fade, and `choose` waits for its landing. */
  fading: boolean
  /** The wall-clock moment an armed switch fires, which may move if its clip is not ready by then. */
  firingAt: number | undefined
  /** Hold is on: auto-advance is paused, and the clip on screen keeps playing (spec §7). */
  held: boolean
  next: Loaded | undefined
  /** The queued clip, by name. See `currentTitle`. */
  nextTitle: string | undefined
  /** `now()` when this snapshot was taken, so a countdown can be read from it. */
  now: number
  /** Output-wide panic. `none` is normal; the two panic buttons toggle between them. */
  panic: PanicMode
  /** The last thing the picture refused: a clip that would not compile, or a frame that threw. The show keeps playing what it has. */
  pictureFault: string | undefined
  /** The loaded track, or `undefined` when none is playing. */
  track: TrackSnapshot | undefined
  /** What Go/Go now will arm next, including how many bars it lasts. */
  transition: TransitionSpec
}

/**
 * Why each control is unavailable, or `undefined` when it is available — one string per control that
 * can refuse.
 *
 * This lives here, beside the snapshot it reads, rather than in the `.svelte` file, for the reason
 * ADR 0001 gives: a template is outside the type and lint gate, and "which refusal is showing" is
 * exactly the kind of decision that silently rots there. It is also the other half of the M1
 * ruling — a control that is disabled with no explanation is indistinguishable from a broken one,
 * so every `false` in `canGo`/`canQueue`/`canSetTransition` has a sentence here to go with it.
 */
export interface ControlHints {
  back: string | undefined
  go: string | undefined
  track: string | undefined
  transition: string | undefined
}

const FADE_RUNNING = 'Fade in progress'

export const controlHints = (snapshot: ControlSnapshot): ControlHints => {
  const track = snapshot.canQueue
    ? undefined
    : `${FADE_RUNNING} — a track can't be loaded until it completes.`
  const transition = snapshot.canSetTransition
    ? undefined
    : `${FADE_RUNNING} — the transition can't be changed until it completes.`

  let back: string | undefined
  if (snapshot.canBack) {
    back = undefined
  } else if (snapshot.fading) {
    back = `${FADE_RUNNING} — Back is unavailable until it completes.`
  } else {
    back = 'Nothing to go back to yet.'
  }

  let go: string | undefined
  if (snapshot.fading) {
    go = `${FADE_RUNNING} — Go is unavailable until it completes; Go now finishes it early.`
  } else if (snapshot.armed) {
    // Not a fault, but still a reason the button is dead: the reducer refuses a second Go over an
    // armed one, and without this the button would look broken between the press and the bar.
    go = 'Armed — the switch fires on the next bar.'
  } else if (!snapshot.canGo) {
    go = 'Nothing is staged — load a track or wait for a candidate.'
  }

  return { back, go, track, transition }
}

export interface CreateControlOptions {
  /** Every clip the control may put on screen, by id. Defaults to `FIXTURES`; `loadTrack` adds a track's own clips to whatever is here. */
  clips?: readonly PlayableClip[]
  /** The one clock: the reducer reads it, the compositor fades against it, and `tap` moves it in place. */
  clock?: Clock
  /** Wall-clock now, per spec: `Date.now()`, never `performance.now()`. */
  now?: () => number
  /** Panic restored after a reload (`client/show-memory.ts`). */
  panic?: PanicMode
  /** The clip shown in slot `a` before anything is queued. Defaults to the second fixture. */
  startClipId?: string
}

export interface Control {
  /** Registers clips the control may play, without queueing one. The live screen adds candidate clips this way once it has fetched their code. */
  addClips: (clips: readonly PlayableClip[]) => void
  /** Returns to the previous clip, reloading its code into the free buffer. Refused with no history or mid-fade. */
  back: () => void
  /** Toggles output-wide blackout (spec §7). Independent of freeze. */
  blackout: () => void
  /**
   * The performer's choice: arms `clipId` for the next bar, replaces an armed choice on the same
   * bar, and waits for the landing during a fade. Keeps the track's cursor, so auto-advance resumes
   * after the item the clip replaced (spec §7).
   */
  choose: (clipId: string) => void
  /** Forgets the loaded track. What is on screen keeps playing — §0: never stop the show. */
  clearTrack: () => void
  /** Toggles a held frame. The show keeps running behind it; only freeze pauses rendering. */
  freeze: () => void
  /** Reads the current state; only for callers that don't need to react to changes. */
  getSnapshot: () => ControlSnapshot
  /** Arms what is staged for the next bar. Does nothing if nothing is staged, a switch is already armed, or a fade is running. */
  go: () => void
  /** Fires what is staged immediately, or — mid-fade — finishes that fade immediately. Does nothing if neither applies. */
  goNow: () => void
  /** Toggles Hold: pause auto-advance without stopping the current clip. Go releases it. */
  hold: () => void
  /** Loads a resolved track and stages its first step. Refused while a fade is running. */
  loadTrack: (track: LoadedTrack) => void
  /** Turns auto-advance on or off (spec §7). With it off, the next step stays staged and waits for Go. */
  setAutoAdvance: (on: boolean) => void
  /** Sets the transition the next switch uses, bars included. Refused while a fade is running. */
  setTransition: (transition: TransitionSpec) => void
  /** Stages `clipId` as the default next clip without arming anything. Keeps the track's cursor, as `choose` does. */
  stage: (clipId: string) => void
  subscribe: (listener: (snapshot: ControlSnapshot) => void) => () => void
  /** Records a tap; once enough taps have accumulated, updates the tempo. */
  tap: () => void
  /** One frame: advances the reducer, the track and the picture. */
  tick: () => void
}

/**
 * The track cursor. Everything about what is playing still lives in `PlaybackState` — the reducer
 * stays the one source of truth (ADR 0004) and this adds no second one. All this records is WHICH
 * STEP the reducer's `current` corresponds to, and the moment that step landed, so auto-advance
 * can measure the step's `bars` from the bar it actually started on.
 */
interface TrackRun {
  /** The moment the switch now landing fired, kept so `startedAt` is the bar the step LANDED on, not the tick that noticed. */
  armedAt: number | undefined
  autoAdvance: boolean
  /**
   * How many clips have played after the track's last item (the performer's picks once the track
   * ran out). `index` stays on that last item, so this is what lets Back walk out of them one at a
   * time instead of mistaking the first Back for a step back through the track.
   */
  beyond: number
  /** The step on screen, or -1 before the first one has landed. */
  index: number
  /** What the staged clip is to the track when it lands: its `queued` step, or a pick after the last item. */
  pending: 'beyond' | 'none' | 'step'
  /** The step staged as `next`; equal to `index` when nothing is staged. */
  queued: number
  /** A step whose clip would not load. Trying it again next frame would only fail again, sixty times a second. */
  refusedStep: number | undefined
  startedAt: number | undefined
  track: LoadedTrack
}

export const createControl = (picture: Picture, options: CreateControlOptions = {}): Control => {
  const now = options.now ?? Date.now
  const startClipId = options.startClipId ?? FIXTURES[1].id

  const clock: Clock = options.clock ?? { beatsPerBar: 4, bpm: 120, downbeatAt: now() }
  let state: PlaybackState =
    options.panic === undefined || options.panic === 'none'
      ? initialPlayback(startClipId, CUT)
      : { ...initialPlayback(startClipId, CUT), panic: options.panic }
  let taps: number[] = []
  const listeners = new Set<(snapshot: ControlSnapshot) => void>()
  const clipsById = new Map<string, PlayableClip>((options.clips ?? FIXTURES).map((clip) => [clip.id, clip]))

  let run: TrackRun | undefined
  let framesSinceLoad = 0
  let pictureFault: string | undefined
  /** A Back's cut, waiting for the buffer it just reloaded to render. */
  let backCut: Slot | undefined
  let notifiedState: PlaybackState | undefined
  let notifiedAt = Number.NEGATIVE_INFINITY

  const snapshot = (): ControlSnapshot => {
    const at = now()
    const stepIndex = run === undefined ? -1 : run.index
    const shownStep = run?.track.steps[Math.max(stepIndex, 0)]
    const elapsedBars =
      run?.startedAt === undefined || shownStep === undefined || stepIndex < 0
        ? 0
        : Math.min(
            shownStep.bars,
            Math.max(0, Math.floor((at - run.startedAt) / barDurationMs(clock.bpm, clock.beatsPerBar))),
          )

    return {
      armed: state.firing !== undefined,
      arrivedBy: state.arrivedBy,
      barPhase: barPhase(clock, at),
      beatsPerBar: clock.beatsPerBar,
      bpm: clock.bpm,
      canBack: canBack(state),
      canGo: canGo(state),
      canGoNow: canGoNow(state),
      canQueue: canQueue(state),
      canSetTransition: canSetTransition(state),
      chosenClipId: state.chosen,
      code: clipsById.get(state.current.clipId)?.code,
      current: state.current,
      currentTitle: clipsById.get(state.current.clipId)?.title,
      fading: state.fading !== undefined,
      firingAt: state.firing?.at,
      held: isHeld(state),
      next: state.next,
      nextTitle: state.next === undefined ? undefined : clipsById.get(state.next.clipId)?.title,
      now: at,
      panic: panicMode(state),
      pictureFault,
      track:
        run === undefined
          ? undefined
          : {
              autoAdvance: run.autoAdvance,
              bars: shownStep?.bars ?? 0,
              elapsedBars,
              index: run.index,
              length: run.track.steps.length,
              queued: run.queued,
              title: run.track.title,
            },
      transition: state.transition,
    }
  }

  const notify = (): void => {
    notifiedState = state
    notifiedAt = now()
    const current = snapshot()
    for (const listener of listeners) {
      listener(current)
    }
  }

  /** A clip that will not compile costs its own switch and nothing else: the show keeps what it has (§0). */
  const loadSlot = (loaded: Loaded): boolean => {
    const clip = clipsById.get(loaded.clipId)
    if (clip === undefined) {
      return false
    }

    if (backCut !== undefined) {
      // The new load takes the slot on screen, so the waiting cut has to happen first.
      picture.switchTo(backCut, CUT, now())
      backCut = undefined
    }
    try {
      picture.load(loaded.slot, clip.code)
    } catch (error) {
      console.error(`vev: clip ${loaded.clipId} did not load`, error)
      pictureFault = `${clip.title} did not load: ${error instanceof Error ? error.message : String(error)}`
      return false
    }
    framesSinceLoad = 0
    pictureFault = undefined
    return true
  }

  /** A switch the reducer fired, or a Go now that ended a fade early, reaching the picture on that frame. */
  const projectSwitch = (before: PlaybackState, event: PlaybackEvent): void => {
    if (state.fading && !before.fading) {
      picture.switchTo(state.fading.to, state.transition, state.fading.startedAt)
    } else if (before.firing && state.current !== before.current) {
      picture.switchTo(state.current.slot, state.transition, before.firing.at)
    } else if (event.kind === 'go-now' && before.fading && state.current !== before.current) {
      picture.switchTo(state.current.slot, CUT, event.now)
    }
  }

  /** Overriding item N makes the override the step after N. With no item after N, the cursor stays on N and counts the pick as beyond the end. */
  const markOverride = (): void => {
    if (run === undefined) {
      return
    }
    if (run.track.steps[run.index + 1] === undefined) {
      run.pending = 'beyond'
    } else {
      run.queued = run.index + 1
      run.pending = 'step'
    }
  }

  /** Undoes `markOverride` once nothing is staged: the next tick stages the track's own step again. */
  const releaseOverride = (): void => {
    if (run !== undefined) {
      run.queued = run.index
      run.pending = 'none'
    }
  }

  /**
   * Moves the track cursor when a switch lands, by what the reducer did rather than by comparing
   * clip ids: a track may name the same clip twice in a row. Measured from the bar the switch fired
   * on — not the tick that noticed it complete — or a crossfade's duration would be charged to every
   * step and the track would drift later and later.
   */
  const followTrack = (before: PlaybackState): void => {
    if (run === undefined) {
      return
    }
    if (before.firing && !state.firing) {
      run.armedAt = state.fading?.startedAt ?? before.firing.at
    }
    if (state.current !== before.current) {
      if (run.pending === 'beyond') {
        run.beyond += 1
      } else if (run.pending === 'step') {
        run.index = run.queued
      }
      run.startedAt = run.armedAt ?? now()
      run.armedAt = undefined
      run.pending = 'none'
      if (before.chosen !== undefined && state.next !== undefined) {
        markOverride()
      }
    }
  }

  /**
   * Every change to playback passes through here: the reducer decides, then the picture and the
   * track cursor follow from the difference. Nothing else calls `picture.switchTo` for a switch, so
   * a decision cannot reach the screen early or twice.
   */
  const dispatch = (event: PlaybackEvent): void => {
    const before = state
    state = reduce(state, event, clock)
    if (state === before) {
      return
    }

    projectSwitch(before, event)
    followTrack(before)

    const { next } = state
    if (next && (before.next?.clipId !== next.clipId || before.next.slot !== next.slot) && !loadSlot(next)) {
      state = reduce(state, { kind: 'unstage' }, clock)
    }
  }

  const addClips = (clips: readonly PlayableClip[]): void => {
    for (const clip of clips) {
      clipsById.set(clip.id, clip)
    }
  }

  const stage = (clipId: string): void => {
    if (!clipsById.has(clipId)) {
      return
    }

    const before = state
    dispatch({ clipId, kind: 'select-next' })
    if (state !== before && state.next !== undefined) {
      markOverride()
    }
    notify()
  }

  const choose = (clipId: string): void => {
    if (!clipsById.has(clipId)) {
      return
    }

    const before = state
    dispatch({ clipId, kind: 'choose', now: now() })
    // During a fade the choice is only held; `followTrack` marks it when it lands.
    if (!state.fading && state.next !== undefined) {
      markOverride()
    } else if (before.firing !== undefined && state.firing === undefined && state.next === undefined) {
      // The choice was taken back, and with it the override it made: the track's own step is next again.
      releaseOverride()
    }
    notify()
  }

  const go = (): void => {
    dispatch({ kind: 'go', now: now() })
    notify()
  }

  const goNow = (): void => {
    dispatch({ kind: 'go-now', now: now() })
    notify()
  }

  const setTransition = (transition: TransitionSpec): void => {
    // Refused while a fade is running (see `playback.ts`). An armed switch reads the transition when
    // it fires, so a change between the press and the bar needs nothing more than this.
    dispatch({ kind: 'set-transition', transition })
    notify()
  }

  const hold = (): void => {
    dispatch({ kind: 'hold' })
    notify()
  }

  /**
   * Returns to the previous clip. The reducer supplies the target and its free buffer, and the
   * clip's code is reloaded there, because two buffers cannot hold an arbitrarily deep history. The
   * cut waits for that buffer to render (`renderFrame`), or Back would flash black on the way.
   */
  const back = (): void => {
    const before = state
    const after = reduce(state, { kind: 'back' }, clock)
    if (after === before || !loadSlot(after.current)) {
      notify()
      return
    }

    state = after
    backCut = state.current.slot

    if (run) {
      if (run.beyond > 0 || run.index > 0) {
        if (run.beyond > 0) {
          run.beyond -= 1
        } else {
          run.index -= 1
        }
        run.queued = run.index
        run.startedAt = now()
        run.armedAt = undefined
        run.pending = 'none'
      } else {
        // Back went before the track's first item; what is on screen is no longer a track step.
        run = undefined
      }
    }
    notify()
  }

  const blackout = (): void => {
    dispatch({ kind: 'blackout' })
    notify()
  }

  const freeze = (): void => {
    dispatch({ kind: 'freeze' })
    notify()
  }

  /**
   * Stages the step after the one on screen: applies its transition and queues its clip, both
   * through `reduce`, so a running fade refuses both exactly as it refuses a manual change. A refusal
   * here is not an error and is not surfaced — it is retried on the next `tick`, which is the whole
   * difference between the performer's own controls (a person pressed them, so a refusal must be
   * visible) and the track's internal book-keeping (nobody pressed anything, and the step lands a
   * frame later).
   */
  const stageNextStep = (): void => {
    if (run === undefined || run.queued !== run.index) {
      return
    }

    const next = run.index + 1
    const step = run.track.steps[next]
    if (step === undefined || run.refusedStep === next) {
      // The track has run out, or cannot go on. What is on screen keeps playing — §0: never stop the show.
      return
    }

    dispatch({ kind: 'set-transition', transition: step.transition })
    dispatch({ clipId: step.clipId, kind: 'select-next' })
    if (state.next?.clipId === step.clipId) {
      run.queued = next
      run.pending = 'step'
    } else if (!state.fading) {
      run.refusedStep = next
    }
  }

  /**
   * Fires Go on the track's behalf once the step on screen has used up its `bars` (spec §7: "A has
   * used up its bars (auto-advance)"). `go` arms at `nextBarAt`, so arming one bar before the target
   * puts the switch on exactly the bar `bars` bars after the step started.
   *
   * A step whose `bars` is no longer than the transition bringing the NEXT one in would come due
   * while that fade is still running, and `reduce` refuses `go` outright then. That is not
   * swallowed: this simply comes back on the following tick, and the step lands late rather than
   * being skipped.
   */
  const autoAdvanceIfDue = (): void => {
    if (run === undefined || !run.autoAdvance || isHeld(state) || run.queued === run.index) {
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
      dispatch({ kind: 'go', now: now() })
    }
  }

  const loadTrack = (track: LoadedTrack): void => {
    // Loading a track stages its first step, so it is legal exactly when queueing is — asked of
    // the reducer's own predicate rather than re-derived here. The screen disables the control on
    // the same `canQueue` and says why, so this refusal is visible rather than silent.
    if (!canQueue(state)) {
      return
    }

    addClips(track.clips)
    run = {
      armedAt: undefined,
      autoAdvance: true,
      beyond: 0,
      index: -1,
      pending: 'none',
      queued: -1,
      refusedStep: undefined,
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
      // In place: the compositor's fade reads this same object.
      clock.bpm = bpm
      clock.downbeatAt = at
    }
    notify()
  }

  /**
   * Draws one frame unless frozen, and reports a staged slot ready once it has rendered. Blackout
   * still renders, because the picture underneath must be current the instant it is lifted. A throw
   * here must not take the reducer's next frame with it, so it is recorded, once per message.
   */
  const renderFrame = (at: number): void => {
    if (panicMode(state) === 'freeze') {
      return
    }

    try {
      picture.tick(at)
    } catch (error) {
      const fault = `The picture threw: ${error instanceof Error ? error.message : String(error)}`
      if (fault !== pictureFault) {
        console.error('vev: the picture threw', error)
        pictureFault = fault
      }
      return
    }

    framesSinceLoad += 1
    if (framesSinceLoad >= READY_FRAMES) {
      if (backCut !== undefined) {
        picture.switchTo(backCut, CUT, at)
        backCut = undefined
      }
      dispatch({ kind: 'next-ready' })
    }
  }

  const tick = (): void => {
    const at = now()
    dispatch({ kind: 'tick', now: at })
    // Retried every tick rather than only on a landing: both `select-next` and `set-transition`
    // are refused while a fade is running, so the first attempt after a landing can legitimately
    // do nothing.
    stageNextStep()
    autoAdvanceIfDue()
    renderFrame(at)

    if (state !== notifiedState || at - notifiedAt >= VIEW_INTERVAL_MS) {
      notify()
    }
  }

  if (loadSlot(state.current)) {
    picture.switchTo(state.current.slot, CUT, now())
  }

  return {
    addClips,
    back,
    blackout,
    choose,
    clearTrack,
    freeze,
    getSnapshot: snapshot,
    go,
    goNow,
    hold,
    loadTrack,
    setAutoAdvance,
    setTransition,
    stage,
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
