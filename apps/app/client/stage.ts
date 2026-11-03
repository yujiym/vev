// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Clock } from '@vev/engines'
import { FIXTURES } from '@vev/engines'
import type { Clip, ClipSummary } from '@vev/shared'

import type { Compositor } from './compositor.ts'
import { createHydraCompositor } from './compositor.ts'
import type { Control, PlayableClip, Picture } from './control.ts'
import { createControl } from './control.ts'
import { fetchClip, fetchLibrary } from './library.ts'
import type { MemoryStorage, ShowMemory } from './show-memory.ts'
import { createShowMemoryWriter, readShowMemory, showMemoryOf } from './show-memory.ts'

/**
 * One frame loop drives the reducer and the picture, on one thread. Kept out of `.svelte`, because a
 * template is outside the type and lint gate (ADR 0001), and every browser dependency is an option
 * with a default, so this is tested with no DOM.
 */

export interface StartStageOptions {
  /** Cancels a handle returned by `requestFrame`. Defaults to `cancelAnimationFrame`. */
  cancelFrame?: (handle: number) => void
  /** The canvas the compositor renders into. */
  canvas: HTMLCanvasElement
  createCompositor?: (clock: Clock) => Compositor | Promise<Compositor>
  fetchClipById?: (id: string) => Promise<Clip>
  fetchLibrarySummaries?: () => Promise<readonly ClipSummary[]>
  /** Wall-clock now, per spec: `Date.now()`, never `performance.now()`. */
  now?: () => number
  /** The picture failed to start or lost its GPU context. The screen says so; the controls still work. */
  onPictureFault?: (message: string) => void
  /** Schedules one frame. Defaults to `requestAnimationFrame`, ignoring its timestamp (`tick` uses `now()`). */
  requestFrame?: (run: () => void) => number
  /** Where a reload finds what it keeps. Defaults to `sessionStorage`. */
  storage?: MemoryStorage
  /** Subscribes to viewport-size changes; returns an unsubscribe function. Defaults to a `window` `'resize'` listener. */
  subscribeResize?: (onResize: (width: number, height: number) => void) => () => void
  /** The initial canvas size. Defaults to the window's current inner size. */
  viewportSize?: () => { height: number; width: number }
}

export interface StartedStage {
  control: Control
  stop: () => void
}

const noop = (): void => {
  // A picture that could not start draws nothing, and the rest of the stage carries on without it.
}

/** Stands in when the compositor could not start, so the panels and the library stay usable. */
const NO_PICTURE: Picture = { load: noop, switchTo: noop, tick: noop }

const defaultRequestFrame = (run: () => void): number =>
  requestAnimationFrame(() => {
    run()
  })

const defaultSubscribeResize = (onResize: (width: number, height: number) => void): (() => void) => {
  const listener = (): void => {
    onResize(window.innerWidth, window.innerHeight)
  }
  window.addEventListener('resize', listener)
  return () => {
    window.removeEventListener('resize', listener)
  }
}

const defaultViewportSize = () => ({ height: window.innerHeight, width: window.innerWidth })

const toPlayable = (clip: Clip): PlayableClip => ({ code: clip.code, id: clip.id, title: clip.title })

/**
 * The clip to open on: what was on screen before a reload, else the library's first clip, else a
 * fixture. No library (or no API) is a normal local start, and candidates are requested straight
 * away (§8.3), so a fixture is only used when there is nothing better.
 */
const resolveStartClip = async (
  memory: ShowMemory | undefined,
  fetchClipById: (id: string) => Promise<Clip>,
  fetchLibrarySummaries: () => Promise<readonly ClipSummary[]>,
): Promise<PlayableClip | undefined> => {
  const fixture = FIXTURES.find((clip) => clip.id === memory?.clipId)
  if (fixture !== undefined) {
    return fixture
  }
  if (memory !== undefined) {
    try {
      return toPlayable(await fetchClipById(memory.clipId))
    } catch (error) {
      console.error('vev: the clip on screen before the reload is gone', error)
    }
  }
  try {
    const [first] = await fetchLibrarySummaries()
    return first === undefined ? undefined : toPlayable(await fetchClipById(first.id))
  } catch (error) {
    console.error('vev: starting from a fixture, the library did not answer', error)
    return undefined
  }
}

const clockFrom = (memory: ShowMemory | undefined, now: number): Clock => ({
  beatsPerBar: memory?.beatsPerBar ?? 4,
  bpm: memory?.bpm ?? 120,
  downbeatAt: memory?.downbeatAt ?? now,
})

/**
 * A GL-context failure on an unfamiliar projector is the realistic way this fails. A black rectangle
 * with nothing said is the silent failure §0 forbids, so it is reported, and the stage carries on.
 */
const mountCompositor = async (
  create: (clock: Clock) => Compositor | Promise<Compositor>,
  clock: Clock,
  canvas: HTMLCanvasElement,
  onFault: (message: string) => void,
): Promise<Compositor | undefined> => {
  try {
    const compositor = await create(clock)
    compositor.mount(canvas)
    return compositor
  } catch (error) {
    console.error('vev: the picture failed to start', error)
    onFault('The picture failed to start. Check the console, then reload.')
    return undefined
  }
}

export const startStage = async (options: StartStageOptions): Promise<StartedStage> => {
  const {
    cancelFrame = cancelAnimationFrame,
    canvas,
    createCompositor = createHydraCompositor,
    fetchClipById = fetchClip,
    fetchLibrarySummaries = fetchLibrary,
    now = Date.now,
    onPictureFault = noop,
    requestFrame = defaultRequestFrame,
    storage = sessionStorage,
    subscribeResize = defaultSubscribeResize,
    viewportSize = defaultViewportSize,
  } = options

  const memory = readShowMemory(storage)
  const startClip = await resolveStartClip(memory, fetchClipById, fetchLibrarySummaries)
  const clock = clockFrom(memory, now())

  const size = viewportSize()
  canvas.width = size.width
  canvas.height = size.height

  let compositor = await mountCompositor(createCompositor, clock, canvas, onPictureFault)

  const onContextLost = (): void => {
    console.error('vev: the picture lost its GPU context')
    onPictureFault('The picture lost its GPU context. Reload to bring it back: the clip and tempo return.')
  }
  canvas.addEventListener('webglcontextlost', onContextLost)

  const unsubscribeResize = subscribeResize((width, height) => {
    compositor?.resize(width, height)
  })

  const control = createControl(compositor ?? NO_PICTURE, {
    clock,
    now,
    panic: memory?.blackout === true ? 'blackout' : 'none',
    ...(startClip === undefined
      ? { startClipId: FIXTURES[0].id }
      : { clips: [...FIXTURES, startClip], startClipId: startClip.id }),
  })

  const remember = createShowMemoryWriter(storage)
  const unsubscribeMemory = control.subscribe((snapshot) => {
    remember(showMemoryOf(snapshot, clock.downbeatAt))
  })

  let frame: number | undefined
  let stopped = false
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
      unsubscribeMemory()
      unsubscribeResize()
      canvas.removeEventListener('webglcontextlost', onContextLost)
      if (frame !== undefined) {
        cancelFrame(frame)
        frame = undefined
      }
      compositor?.dispose()
      compositor = undefined
    },
  }
}
