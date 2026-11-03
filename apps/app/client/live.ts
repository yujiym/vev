// SPDX-License-Identifier: AGPL-3.0-or-later
import { chooseTransition, interpretDirection, withVariety } from '@vev/decision'
import { candidateResponseSchema, DEFAULT_TRANSITION } from '@vev/shared'
import type {
  AnnotationStatus,
  CandidateRequest,
  CandidateResponse,
  CandidateResult,
  Clip,
  ClipEnergy,
  ClipSummary,
  Direction,
  EngineKind,
  TransitionKind,
  TransitionSpec,
} from '@vev/shared'
import * as v from 'valibot'

import type { Control, ControlSnapshot, PlayableClip, TrackStep } from './control.ts'
import { failure, fetchClip, fetchLibrary, thumbnailUrl } from './library.ts'

/**
 * The live screen's data. Everything the performer is offered, what it was offered for, and what
 * happens when they pick it. Kept out of `.svelte` because templates are outside the type and lint
 * gate (ADR 0001), and because the candidate request has a lifecycle — ignore an answer that
 * belongs to a superseded question, keep the last answer when a new one fails — that is exactly
 * the kind of rule a template must not own.
 */

/** How many recent transitions the variety rule reads (spec §9.2: three in a row). */
const RECENT_LIMIT = 6

/** How many of the library's best clips the route may put in front of its model (`limit`, §8.1). */
const CANDIDATE_LIMIT = 20

/** How many candidates the stage shows (§8.1 returns three). */
const CARD_LIMIT = 3

/** How many clips are sent as history; spec §8.2's state lists the last five. */
const HISTORY_LIMIT = 5

export type CandidateLoad = 'idle' | 'loading' | 'ok' | 'stale'

/** What the screen knows about a clip beyond the candidate result itself. */
export interface ClipMeta {
  annotationStatus?: AnnotationStatus | undefined
  /** Only a fetched clip has these two; a library summary carries a licence but no author. */
  author?: string | undefined
  energy?: ClipEnergy | undefined
  engine?: EngineKind | undefined
  license?: string | undefined
  reviewed?: boolean | undefined
  thumbnailKey?: string | undefined
  title: string
  usesFeedback?: boolean | undefined
}

export interface CandidateView extends CandidateResult {
  annotationStatus: AnnotationStatus | undefined
  clipId: string
  energy: ClipEnergy | undefined
  engine: EngineKind | undefined
  reviewed: boolean | undefined
  thumbnailKey: string | undefined
  thumbnailUrl: string | undefined
  title: string
  usesFeedback: boolean | undefined
}

export interface LiveState {
  candidates: readonly CandidateView[]
  direction?: Direction
  error?: string
  /** Most recent last, as spec §8.2's history lists it. */
  historyIds: readonly string[]
  load: CandidateLoad
  /** The clip the last request was about. Distinguishes a stale answer from a current one. */
  requestedFor?: string
  /** Monotonic: a response carrying any other id is an answer to a question nobody is asking now. */
  requestId: number
  /** The candidate the performer picked for the next switch, if any (spec §7, §12.1). */
  pickedClipId?: string
  suggestedTransition?: TransitionSpec
  /** The performer's explicit transition choice for this switch. */
  transition?: TransitionSpec
  recentTransitions: readonly TransitionKind[]
}

export const initialLive = (): LiveState => ({
  candidates: [],
  historyIds: [],
  load: 'idle',
  recentTransitions: [],
  requestId: 0,
})

/** A new question is about to be asked. The id moves immediately, so any older answer is stale. */
export const beginRequest = (state: LiveState, clipId: string): LiveState => ({
  ...state,
  error: undefined,
  load: 'loading',
  requestId: state.requestId + 1,
  requestedFor: clipId,
})

/**
 * A chosen clip is a commitment that outlives the answer it was chosen from: a new answer arriving
 * before its bar must not take the outlined card off the screen. It stays as the last card.
 */
const keepingPick = (candidates: readonly CandidateView[], state: LiveState): readonly CandidateView[] => {
  const picked = state.candidates.find((candidate) => candidate.clipId === state.pickedClipId)
  if (picked === undefined || candidates.some((candidate) => candidate.clipId === picked.clipId)) {
    return candidates
  }
  return [...candidates.slice(0, CARD_LIMIT - 1), picked]
}

/** The answer to the current question, with each candidate joined to what the library knows. */
export const applyCandidates = (
  state: LiveState,
  requestId: number,
  response: CandidateResponse,
  clips: ReadonlyMap<string, ClipMeta>,
): LiveState => {
  if (requestId !== state.requestId) {
    return state
  }

  const candidates: CandidateView[] = response.candidates.map((candidate) => {
    const meta = clips.get(candidate.clipId)
    return {
      ...candidate,
      annotationStatus: meta?.annotationStatus,
      clipId: candidate.clipId,
      energy: meta?.energy,
      engine: meta?.engine,
      reviewed: meta?.reviewed,
      thumbnailKey: meta?.thumbnailKey,
      thumbnailUrl: meta === undefined ? undefined : thumbnailUrl(meta),
      title: meta?.title ?? candidate.clipId,
      usesFeedback: meta?.usesFeedback,
    }
  })

  return {
    ...state,
    candidates: keepingPick(candidates, state),
    error: undefined,
    load: 'ok',
    suggestedTransition: response.suggestedTransition,
  }
}

/**
 * Candidates, and any pick or transition choice made against them, belong to the question they
 * answered. A new track changes that question (its licence mode, its sections), so what is on
 * screen is not stale but wrong: a clip ranked for an ordinary track may not be played in a
 * commercial one (spec §14.2).
 */
export const discardCandidates = (state: LiveState): LiveState => ({
  ...state,
  candidates: [],
  pickedClipId: undefined,
  suggestedTransition: undefined,
  transition: undefined,
})

/**
 * A failed request keeps the last candidates and marks them stale (spec §0 principle 2). Returning
 * to an empty screen because the network blinked would be the show stopping; the performer keeps
 * a usable Next, labelled as old, and playback never notices.
 */
export const failRequest = (state: LiveState, requestId: number, error: string): LiveState => {
  if (requestId !== state.requestId) {
    return state
  }

  return { ...state, error, load: 'stale' }
}

/**
 * A clip stopped being current and a transition replaced it. Both records move in this one step so
 * they cannot drift apart. The clip log is the play log spec §8.2 asks for, not the reducer's Back
 * stack: a clip the performer backed out of was still shown, and stays in it.
 */
export const recordArrival = (state: LiveState, left: string, arrival: TransitionKind): LiveState => ({
  ...state,
  historyIds: [...state.historyIds, left].slice(-20),
  recentTransitions: [...state.recentTransitions, arrival].slice(-RECENT_LIMIT),
})

/** The performer's pick wins over the track's own next item (spec §7). */
export const pickCandidate = (state: LiveState, clipId: string): LiveState => ({
  ...state,
  pickedClipId: clipId,
  transition: undefined,
})

/** The performer's one-click transition choice, which outranks every automatic rule (spec §9.2). */
export const chooseTransitionManually = (state: LiveState, transition: TransitionSpec): LiveState => ({
  ...state,
  transition,
})

export interface LiveNext {
  candidateIndex?: number
  clipId: string
  /** `staged` is a clip the control holds that no current candidate or track step names. */
  source: 'candidate' | 'staged' | 'track'
  title?: string
  transition: TransitionSpec
  /** `staged` is the transition already set on the control, which a late answer may not change once a switch is armed. */
  transitionFrom: 'locked' | 'performer' | 'rules' | 'staged' | 'suggested' | 'track'
}

export interface TrackNext {
  clipId: string
  energy?: ClipEnergy
  engine: EngineKind
  /** The track item's transition (spec §5 `TrackItem.transitionIn`). */
  locked: boolean
  transition: TransitionSpec
}

export interface NextInput {
  current?: ClipMeta
  currentClipId: string
  defaultTransition: TransitionSpec
  lookup: (clipId: string) => ClipMeta | undefined
  nextSection?: string
  recentTransitions: readonly TransitionKind[]
  trackNext?: TrackNext
}

/**
 * What plays next, and the transition that brings it in.
 *
 * The order is spec §7 and §9.2 together: the performer's pick, then the track's own next item,
 * then candidate #1. The transition is the performer's explicit choice, then the track item's
 * (locked items are never re-chosen), then the decision response's suggestion for candidate #1,
 * and finally the rules — which is why a candidate the response did not rank first, and a picked
 * Next, still get a considered transition.
 */
const pickedNext = (state: LiveState, input: NextInput): LiveNext | undefined => {
  const index = state.candidates.findIndex(
    (candidate) => candidate.clipId === state.pickedClipId && candidate.clipId !== input.currentClipId,
  )
  const picked = state.candidates[index]
  if (picked === undefined) {
    return undefined
  }
  return {
    candidateIndex: index,
    clipId: picked.clipId,
    source: 'candidate',
    title: picked.title,
    transition: input.defaultTransition,
    transitionFrom: 'rules',
  }
}

const trackItemNext = (input: NextInput): LiveNext | undefined => {
  const { trackNext } = input
  if (trackNext === undefined) {
    return undefined
  }
  return {
    clipId: trackNext.clipId,
    source: 'track',
    title: input.lookup(trackNext.clipId)?.title,
    transition: trackNext.transition,
    transitionFrom: trackNext.locked ? 'locked' : 'track',
  }
}

/** Candidate #1 — or the first one that is not already on screen, so a stale answer cannot loop a clip. */
const leadingCandidateNext = (state: LiveState, input: NextInput): LiveNext | undefined => {
  const index = state.candidates.findIndex((candidate) => candidate.clipId !== input.currentClipId)
  const leading = state.candidates[index]
  if (leading === undefined) {
    return undefined
  }
  return {
    candidateIndex: index,
    clipId: leading.clipId,
    source: 'candidate',
    title: leading.title,
    transition: input.defaultTransition,
    transitionFrom: 'rules',
  }
}

/**
 * The transition for a candidate: the response's suggestion for #1, the rules for any other. The
 * suggestion is made by a Worker that never sees what was played, so the variety rule (spec §9.2:
 * three in a row make the fourth different) is applied here, where the record lives.
 */
const automaticTransition = (state: LiveState, input: NextInput, selected: LiveNext): LiveNext => {
  if (selected.candidateIndex === 0 && state.suggestedTransition !== undefined) {
    const transition = withVariety(state.suggestedTransition, input.recentTransitions)
    return {
      ...selected,
      transition,
      transitionFrom: transition === state.suggestedTransition ? 'suggested' : 'rules',
    }
  }

  const nextMeta = input.lookup(selected.clipId)
  const engine = nextMeta?.engine ?? input.current?.engine ?? 'hydra'
  const transition = chooseTransition({
    current: { energy: input.current?.energy, engine: input.current?.engine ?? engine },
    defaultTransition: input.defaultTransition,
    next: {
      energy: nextMeta?.energy,
      engine,
      usesFeedback: nextMeta?.usesFeedback ?? false,
    },
    nextSection: input.nextSection,
    recent: input.recentTransitions.slice(-3),
  })

  return { ...selected, transition, transitionFrom: 'rules' }
}

export const selectNext = (state: LiveState, input: NextInput): LiveNext | undefined => {
  const selected = pickedNext(state, input) ?? trackItemNext(input) ?? leadingCandidateNext(state, input)
  if (selected === undefined) {
    return undefined
  }

  if (state.transition !== undefined) {
    return { ...selected, transition: state.transition, transitionFrom: 'performer' }
  }

  return selected.source === 'track' ? selected : automaticTransition(state, input, selected)
}

const sameTransition = (a: TransitionSpec, b: TransitionSpec): boolean =>
  a.kind === b.kind && a.bars === b.bars

/** The one-click change: cut → 1-bar fade → 2-bar fade → 4-bar fade → cut. */
export const nextTransitionChoice = (transition: TransitionSpec): TransitionSpec => {
  if (transition.kind === 'cut') {
    return { bars: 1, kind: 'crossfade' }
  }
  if (transition.bars <= 1) {
    return { bars: 2, kind: 'crossfade' }
  }
  if (transition.bars <= 2) {
    return { bars: 4, kind: 'crossfade' }
  }
  return { bars: 0, kind: 'cut' }
}

/** What the NEXT panel calls a transition. */
export const transitionLabel = (transition: TransitionSpec): string =>
  transition.kind === 'cut' ? 'Cut' : `Crossfade ${transition.bars} ${transition.bars === 1 ? 'bar' : 'bars'}`

export type DecisionTone = 'decision' | 'fallback' | 'idle' | 'loading' | 'stale'

export interface DecisionStatus {
  label: string
  providerId?: string | undefined
  tone: DecisionTone
}

/** The control row's decision dot: which layer produced the candidates, and whether they are current. */
export const decisionStatus = (state: LiveState): DecisionStatus => {
  if (state.load === 'stale') {
    return { label: 'stale — keeping the last candidates', tone: 'stale' }
  }
  if (state.load === 'loading') {
    return { label: 'asking…', tone: 'loading' }
  }
  if (state.load === 'idle') {
    return { label: 'waiting for a clip', tone: 'idle' }
  }

  const [top] = state.candidates
  if (top === undefined) {
    return { label: 'no candidates', tone: 'fallback' }
  }
  if (top.source === 'decision') {
    return { label: top.providerId ?? 'decision provider', providerId: top.providerId, tone: 'decision' }
  }
  return { label: 'rule ranking', tone: 'fallback' }
}

export type LiveKeyAction =
  | { kind: 'blackout' }
  | { kind: 'chat' }
  | { kind: 'close-menu' }
  | { kind: 'close-panel' }
  | { index: 0 | 1 | 2; kind: 'choose-candidate' }
  | { kind: 'freeze' }
  | { kind: 'go' }
  | { kind: 'go-now' }
  | { kind: 'hold' }

export interface KeyEventLike {
  altKey?: boolean
  ctrlKey?: boolean
  key: string
  metaKey?: boolean
  shiftKey?: boolean
}

const KEY_ACTIONS = new Map<string, LiveKeyAction>([
  ['1', { index: 0, kind: 'choose-candidate' }],
  ['2', { index: 1, kind: 'choose-candidate' }],
  ['3', { index: 2, kind: 'choose-candidate' }],
  ['B', { kind: 'blackout' }],
  ['C', { kind: 'chat' }],
  ['Escape', { kind: 'freeze' }],
  ['H', { kind: 'hold' }],
  ['b', { kind: 'blackout' }],
  ['c', { kind: 'chat' }],
  ['h', { kind: 'hold' }],
])

const TEXT_INPUT_TAGS = new Set(['INPUT', 'SELECT', 'TEXTAREA'])

/** The parts of a DOM element the key map reads; the page hands over `event.target` when it is one. */
export interface KeyTarget {
  /** The element is inside a panel, where a focused button keeps its own Space. */
  inPanel?: boolean
  isContentEditable?: boolean
  tagName?: string
}

/** True when a keystroke belongs to a field rather than to the transport (spec §12.1). */
export const isTextEntry = (target: KeyTarget | undefined): boolean =>
  target !== undefined &&
  (target.isContentEditable === true ||
    (target.tagName !== undefined && TEXT_INPUT_TAGS.has(target.tagName.toUpperCase())))

/**
 * Spec §12's key map, as data rather than a chain in the template.
 *
 * `Esc` closes the open menu, then an open panel, before it means Freeze, wherever the focus is. Typing in a field
 * suspends every single-key shortcut, because those keys are the performer's sentence, not the
 * transport. A panel that is merely open does not: the show is still running behind it.
 */
export const keyAction = (
  event: KeyEventLike,
  options: { inPanel?: boolean; menuOpen?: boolean; panelOpen: boolean; textEntry: boolean },
): LiveKeyAction | undefined => {
  if (event.key === 'Escape' && options.menuOpen === true) {
    return { kind: 'close-menu' }
  }
  if (event.key === 'Escape' && options.panelOpen) {
    return { kind: 'close-panel' }
  }
  if (options.inPanel === true && event.key === ' ') {
    return undefined
  }
  if (options.textEntry || event.ctrlKey === true || event.metaKey === true || event.altKey === true) {
    return undefined
  }

  if (event.key === ' ' || event.key === 'Spacebar') {
    return event.shiftKey === true ? { kind: 'go-now' } : { kind: 'go' }
  }
  return KEY_ACTIONS.get(event.key)
}

/** A track as the live screen needs it: id and mode for the request, steps for the timeline and sections. */
export interface LiveTrack {
  defaultTransition: TransitionSpec
  id: string
  mode: 'commercial' | 'noncommercial'
  steps: readonly TrackStep[]
  title: string
}

export interface LiveSnapshot {
  candidates: readonly CandidateView[]
  current: ClipMeta | undefined
  decision: DecisionStatus
  direction: Direction | undefined
  error: string | undefined
  historyIds: readonly string[]
  load: CandidateLoad
  next: LiveNext | undefined
  pickedClipId: string | undefined
  recentTransitions: readonly TransitionKind[]
  suggestedTransition: TransitionSpec | undefined
  track: LiveTrack | undefined
}

/** One subscription gives the page everything it renders: transport state and the candidate state. */
export interface LiveView {
  control: ControlSnapshot
  live: LiveSnapshot
}

export interface CreateLiveOptions {
  control: Control
  fetchCandidates?: (body: CandidateRequest) => Promise<CandidateResponse>
  fetchClipById?: (id: string) => Promise<Clip>
  fetchLibrarySummaries?: () => Promise<readonly ClipSummary[]>
  /** Wall-clock now, per spec: `Date.now()`. */
  now?: () => number
  onChat?: () => void
  onCloseMenu?: () => void
  onClosePanel?: () => void
}

export interface Live {
  /** Applies the performer's one-click transition choice to this switch. */
  chooseTransition: (transition: TransitionSpec) => void
  /** Clears the standing direction and asks again (spec §8.6). */
  clearDirection: () => void
  getSnapshot: () => LiveView
  /** Turns a sentence into a standing direction and asks for new candidates. Never moves the show. */
  interpret: (text: string) => void
  /** Handles one key event; returns true when it consumed the key. */
  key: (
    event: KeyEventLike & { target?: KeyTarget },
    options: { menuOpen?: boolean; panelOpen: boolean },
  ) => boolean
  /** The performer's candidate choice: arms the switch for the next bar (§7). */
  pickCandidate: (clipId: string) => void
  /** The track being played, or `undefined` once it leaves one. */
  setTrack: (track: LiveTrack | undefined) => void
  stop: () => void
  subscribe: (listener: (view: LiveView) => void) => () => void
}

const defaultFetchCandidates = async (body: CandidateRequest): Promise<CandidateResponse> => {
  const response = await fetch('/api/candidates', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw await failure(response, 'POST /api/candidates')
  }

  return v.parse(candidateResponseSchema, await response.json())
}

const toPlayable = (clip: Clip): PlayableClip => ({ code: clip.code, id: clip.id, title: clip.title })

/**
 * A fetched clip as the rest of this module reads it. A `Clip` keeps its feedback flag at
 * `deps.usesFeedback`, while everything downstream (the transition rules, the candidate cards)
 * looks for `usesFeedback` at the top level, so a raw `Clip` read as a `ClipMeta` is silently
 * "not feedback". This is the one place the two shapes meet.
 */
const toMeta = (clip: Clip): ClipMeta => ({
  annotationStatus: clip.annotationStatus,
  author: clip.author,
  energy: clip.energy,
  engine: clip.engine,
  license: clip.license,
  reviewed: clip.reviewed,
  thumbnailKey: clip.thumbnailKey,
  title: clip.title,
  usesFeedback: clip.deps.usesFeedback,
})

/** A pick stands while it is staged or held through a fade. A landing, a Back or a clip that would not load all end it. */
const pickStands = (control: ControlSnapshot, clipId: string): boolean =>
  control.next?.clipId === clipId || control.chosenClipId === clipId

/**
 * Wires the candidate pipeline to the control.
 *
 * One request goes out when the screen opens and after every landing (spec §8.3: "right after A
 * starts"), and immediately when the direction changes. A landing also moves the old clip into
 * history and consumes the transition that brought it in, which is what the variety rule reads.
 * The chat never moves the show; a candidate only does when the performer chooses it.
 */
export const createLive = (options: CreateLiveOptions): Live => {
  const {
    control,
    fetchCandidates = defaultFetchCandidates,
    fetchClipById = fetchClip,
    fetchLibrarySummaries = fetchLibrary,
    now = Date.now,
    onChat = () => {
      // No chat surface attached — the key is still consumed elsewhere.
    },
    onCloseMenu = () => {
      // Same.
    },
    onClosePanel = () => {
      // Same.
    },
  } = options

  let live = initialLive()
  let controlSnapshot = control.getSnapshot()
  let track: LiveTrack | undefined
  let lastCurrent: string | undefined
  let stopped = false
  let syncing = false
  let libraryRequest: Promise<void> | undefined

  const summaries = new Map<string, ClipMeta>()
  /** Candidates whose code has been fetched: the only ones that can be staged. */
  const fetched = new Map<string, ClipMeta>()
  const listeners = new Set<(view: LiveView) => void>()

  const lookup = (clipId: string): ClipMeta | undefined => fetched.get(clipId) ?? summaries.get(clipId)

  const ensureLibrary = async (): Promise<void> => {
    if (libraryRequest !== undefined) {
      await libraryRequest
      return
    }
    libraryRequest = (async () => {
      try {
        const list = await fetchLibrarySummaries()
        for (const summary of list) {
          summaries.set(summary.id, summary)
        }
      } catch (error) {
        // Candidate requests can still work with no summaries; the full-clip fetch fills the
        // titles in. Retry on the next request rather than caching a failure for the whole show.
        libraryRequest = undefined
        console.error('vev: could not load the clip library for candidate labels', error)
      }
    })()
    await libraryRequest
  }

  const fetchOrNull = async (id: string): Promise<Clip | null> => {
    try {
      return await fetchClipById(id)
    } catch (error) {
      console.error(`vev: could not fetch candidate clip ${id}; it cannot be staged`, error)
      return null
    }
  }

  const ensureClips = async (ids: readonly string[]): Promise<void> => {
    const missing = [...new Set(ids)].filter((id) => !fetched.has(id))
    const clips = await Promise.all(missing.map(fetchOrNull))

    const playable: PlayableClip[] = []
    for (const clip of clips) {
      if (clip !== null) {
        fetched.set(clip.id, toMeta(clip))
        playable.push(toPlayable(clip))
      }
    }
    if (playable.length > 0) {
      control.addClips(playable)
    }
  }

  const trackNextFor = (): TrackNext | undefined => {
    if (track === undefined || controlSnapshot.track === undefined) {
      return undefined
    }
    const index = controlSnapshot.track.index < 0 ? 0 : controlSnapshot.track.index + 1
    const step = track.steps[index]
    if (step === undefined) {
      return undefined
    }

    const meta = lookup(step.clipId)
    return {
      clipId: step.clipId,
      energy: meta?.energy,
      engine: meta?.engine ?? 'hydra',
      // `TrackItem.transitionLocked` has no column yet (spec §17); an item's transition is
      // automatic until one exists, so nothing is reported locked here.
      locked: false,
      transition: step.transition,
    }
  }

  const contextFor = () => {
    const index = controlSnapshot.track?.index ?? -1
    const step = track?.steps[Math.max(index, 0)]
    const next = track?.steps[index < 0 ? 0 : index + 1]
    return {
      defaultTransition: track?.defaultTransition ?? DEFAULT_TRANSITION,
      nextSection: next?.section,
      section: index < 0 ? undefined : step?.section,
    }
  }

  const desiredNext = (): LiveNext | undefined => {
    const context = contextFor()
    return selectNext(live, {
      current: lookup(controlSnapshot.current.clipId),
      currentClipId: controlSnapshot.current.clipId,
      defaultTransition: context.defaultTransition,
      lookup,
      nextSection: context.nextSection,
      recentTransitions: live.recentTransitions,
      trackNext: trackNextFor(),
    })
  }

  /**
   * Brings the control's staged Next and transition in line with what the screen shows.
   *
   * Once a switch is armed it is committed: an answer that merely arrived late, or a track step
   * that came due, must not swap the clip that is about to go live. The performer's own pick or
   * transition change is the one thing allowed through, because that is a deliberate act.
   */
  const syncNext = ({ performer }: { performer: boolean }): void => {
    if (syncing) {
      return
    }

    const desired = desiredNext()
    if (desired === undefined) {
      return
    }

    const current = control.getSnapshot()
    if (current.armed && !performer) {
      return
    }

    syncing = true
    try {
      const { transition } = desired
      const sameClip = current.next?.clipId === desired.clipId

      if (!sameTransition(current.transition, transition)) {
        control.setTransition(transition)
      }
      if (!sameClip) {
        control.stage(desired.clipId)
      }
    } finally {
      syncing = false
    }
  }

  /**
   * What will play, as the control holds it. The screen's own idea of Next (`desiredNext`) is only
   * what it wants staged: once a switch is armed, or while a fade is running, the control refuses
   * the change, and showing the wish would name a clip that is not the one about to go live.
   */
  const stagedNext = (): LiveNext | undefined => {
    const staged = controlSnapshot.next
    if (staged === undefined) {
      return undefined
    }

    const { transition } = controlSnapshot
    const desired = desiredNext()
    if (desired?.clipId === staged.clipId) {
      return sameTransition(desired.transition, transition)
        ? desired
        : { ...desired, transition, transitionFrom: 'staged' }
    }

    const base = { clipId: staged.clipId, title: lookup(staged.clipId)?.title, transition }
    if (trackNextFor()?.clipId === staged.clipId) {
      return { ...base, source: 'track', transitionFrom: 'staged' }
    }
    const candidateIndex = live.candidates.findIndex((candidate) => candidate.clipId === staged.clipId)
    return candidateIndex === -1
      ? { ...base, source: 'staged', transitionFrom: 'staged' }
      : { ...base, candidateIndex, source: 'candidate', transitionFrom: 'staged' }
  }

  const snapshot = (): LiveView => ({
    control: controlSnapshot,
    live: {
      candidates: live.candidates,
      current: lookup(controlSnapshot.current.clipId),
      decision: decisionStatus(live),
      direction: live.direction,
      error: live.error,
      historyIds: live.historyIds,
      load: live.load,
      next: stagedNext(),
      pickedClipId: live.pickedClipId,
      recentTransitions: live.recentTransitions,
      suggestedTransition: live.suggestedTransition,
      track,
    },
  })

  const notify = (): void => {
    const view = snapshot()
    for (const listener of listeners) {
      listener(view)
    }
  }

  const requestBody = (currentClipId: string): CandidateRequest => {
    const context = contextFor()
    const body: CandidateRequest = {
      commercial: track?.mode === 'commercial',
      currentClipId,
      historyIds: live.historyIds.slice(-HISTORY_LIMIT),
      limit: CANDIDATE_LIMIT,
    }
    if (live.direction !== undefined) {
      body.direction = live.direction
    }
    if (context.nextSection !== undefined) {
      body.nextSection = context.nextSection
    }
    if (context.section !== undefined) {
      body.section = context.section
    }
    if (track !== undefined) {
      body.trackId = track.id
    }
    return body
  }

  const request = async (): Promise<void> => {
    if (stopped) {
      return
    }

    const current = controlSnapshot.current.clipId
    live = beginRequest(live, current)
    const { requestId } = live
    notify()

    try {
      const [, response] = await Promise.all([ensureLibrary(), fetchCandidates(requestBody(current))])
      if (stopped || requestId !== live.requestId) {
        return
      }

      // The clip on screen too, when the library knows it: the credit overlay needs its author.
      const onScreen = summaries.has(current) ? [current] : []
      await ensureClips([...onScreen, ...response.candidates.map((candidate) => candidate.clipId)])
      if (stopped || requestId !== live.requestId) {
        return
      }

      // A candidate whose code could not be fetched cannot be staged, so it is not offered: a card
      // the performer can click that silently does nothing is worse than two honest ones.
      const playable = {
        ...response,
        candidates: response.candidates.filter((candidate) => fetched.has(candidate.clipId)),
      }
      live = applyCandidates(live, requestId, playable, new Map([...summaries, ...fetched]))
      syncNext({ performer: false })
    } catch (error) {
      live = failRequest(live, requestId, error instanceof Error ? error.message : 'unknown error')
    }

    if (!stopped) {
      notify()
    }
  }

  const dropEndedPick = (snapshotNext: ControlSnapshot): void => {
    const { pickedClipId } = live
    if (pickedClipId !== undefined && !pickStands(snapshotNext, pickedClipId)) {
      live = { ...live, pickedClipId: undefined, transition: undefined }
    }
  }

  const onControl = (snapshotNext: ControlSnapshot): void => {
    controlSnapshot = snapshotNext

    if (lastCurrent === undefined) {
      lastCurrent = snapshotNext.current.clipId
      void request()
    } else if (lastCurrent !== snapshotNext.current.clipId) {
      live = recordArrival(live, lastCurrent, (snapshotNext.arrivedBy ?? snapshotNext.transition).kind)
      live = { ...live, transition: undefined }
      lastCurrent = snapshotNext.current.clipId
      void request()
    }

    // Mid-`choose` the pick is not staged yet, and `choose` looks again when it has finished.
    if (!syncing) {
      dropEndedPick(snapshotNext)
    }

    // An armed pick is the performer's own act, so its transition still follows the rules: a choice
    // held through a fade could not set one until now, and what it fades from has just changed.
    syncNext({ performer: live.pickedClipId !== undefined })
    notify()
  }

  const choose = (clipId: string): void => {
    if (clipId === controlSnapshot.current.clipId) {
      return
    }

    live = pickCandidate(live, clipId)
    syncing = true
    try {
      const desired = desiredNext()
      if (desired !== undefined) {
        // Refused mid-fade; `onControl` applies it on the landing.
        control.setTransition(desired.transition)
      }
      control.choose(clipId)
    } finally {
      syncing = false
    }
    dropEndedPick(control.getSnapshot())
    // A choice taken back leaves nothing staged: Next falls back to the track's own step, or the first candidate.
    syncNext({ performer: false })
    notify()
  }

  const unsubscribe = control.subscribe(onControl)

  return {
    chooseTransition: (transition) => {
      if (!controlSnapshot.canSetTransition) {
        return
      }
      live = chooseTransitionManually(live, transition)
      syncNext({ performer: true })
      notify()
    },
    clearDirection: () => {
      live = { ...live, direction: undefined }
      void request()
      notify()
    },
    getSnapshot: snapshot,
    interpret: (text) => {
      const trimmed = text.trim()
      if (trimmed === '') {
        return
      }
      live = { ...live, direction: interpretDirection(trimmed, now()) }
      void request()
      notify()
    },
    key: (event, keyOptions) => {
      const action = keyAction(event, {
        inPanel: event.target?.inPanel,
        menuOpen: keyOptions.menuOpen,
        panelOpen: keyOptions.panelOpen,
        textEntry: isTextEntry(event.target),
      })
      if (action === undefined) {
        return false
      }

      switch (action.kind) {
        case 'blackout': {
          control.blackout()
          return true
        }
        case 'chat': {
          onChat()
          return true
        }
        case 'close-menu': {
          onCloseMenu()
          return true
        }
        case 'close-panel': {
          onClosePanel()
          return true
        }
        case 'freeze': {
          control.freeze()
          return true
        }
        case 'go': {
          control.go()
          return true
        }
        case 'go-now': {
          control.goNow()
          return true
        }
        case 'hold': {
          control.hold()
          return true
        }
        case 'choose-candidate': {
          const candidate = live.candidates[action.index]
          if (candidate === undefined) {
            return false
          }
          choose(candidate.clipId)
          return true
        }
        default: {
          return false
        }
      }
    },
    pickCandidate: (clipId) => {
      if (live.candidates.some((candidate) => candidate.clipId === clipId)) {
        choose(clipId)
      }
    },
    setTrack: (next) => {
      track = next
      live = discardCandidates(live)
      // Asking bumps the request id, which also drops any answer still in flight for the old track.
      void request()
      syncNext({ performer: true })
      notify()
    },
    stop: () => {
      stopped = true
      unsubscribe()
      listeners.clear()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      listener(snapshot())
      return () => {
        listeners.delete(listener)
      }
    },
  }
}
