// SPDX-License-Identifier: AGPL-3.0-or-later
import { FIXTURES, nextBarAt } from '@vev/engines'
import type { Slot, TransitionSpec } from '@vev/shared'
import { describe, expect, it, vi } from 'vitest'

import type {
  Control,
  CreateControlOptions,
  LoadedTrack,
  Picture,
  PlayableClip,
  TrackStep,
} from './control.ts'
import { controlHints, createControl } from './control.ts'

type PictureCall =
  | { code: string; kind: 'load'; slot: Slot }
  | { at: number; kind: 'switch'; to: Slot; transition: TransitionSpec }

/** What the picture was told, in order. A switch appearing here is the moment it reached the screen. */
const fakePicture = () => {
  const messages: PictureCall[] = []
  const ticks: number[] = []
  const picture: Picture = {
    load: (slot, code) => {
      messages.push({ code, kind: 'load', slot })
    },
    switchTo: (to, transition, at) => {
      messages.push({ at, kind: 'switch', to, transition })
    },
    tick: (now) => {
      ticks.push(now)
    },
  }
  return { messages, picture, ticks }
}

/**
 * A control whose slots are always rendered in time: every call that loads a clip is followed by
 * the frames a real loop would draw. What happens when they are NOT in time is the subject of the
 * `the picture obeys the reducer` block, which uses `createControl` bare.
 */
const setup = (options: CreateControlOptions = {}) => {
  const { messages, picture, ticks } = fakePicture()
  const bare = createControl(picture, options)
  messages.length = 0
  const rendered = (): void => {
    bare.tick()
    bare.tick()
  }
  const control: Control = {
    ...bare,
    choose: (clipId) => {
      bare.choose(clipId)
      rendered()
    },
    loadTrack: (track) => {
      bare.loadTrack(track)
      rendered()
    },
    stage: (clipId) => {
      bare.stage(clipId)
      rendered()
    },
    tick: () => {
      bare.tick()
      rendered()
    },
  }
  return { bare, control, messages, picture, ticks }
}

/** A controllable wall clock: `set` moves it, `advance` steps it forward. */
const createFakeNow = (start: number) => {
  let current = start
  return {
    advance: (ms: number): number => {
      current += ms
      return current
    },
    now: (): number => current,
    set: (value: number): number => {
      current = value
      return current
    },
  }
}

const FADE_SPEC = { bars: 2, kind: 'crossfade' } as const
const CUT_SPEC = { bars: 0, kind: 'cut' } as const

const switches = (messages: readonly PictureCall[]) => messages.filter((call) => call.kind === 'switch')

describe(createControl, () => {
  it('puts the start clip on the picture as soon as it exists', () => {
    const { messages, picture } = fakePicture()
    createControl(picture, { now: () => 700, startClipId: 'quiet' })

    expect(messages).toStrictEqual([
      { code: FIXTURES[0].code, kind: 'load', slot: 'a' },
      { at: 700, kind: 'switch', to: 'a', transition: CUT_SPEC },
    ])
  })

  it('staging a clip loads it into the free slot', () => {
    const { control, messages } = setup({ startClipId: 'quiet' })

    control.stage('loud')

    expect(messages).toStrictEqual([{ code: FIXTURES[1].code, kind: 'load', slot: 'b' }])
  })

  it('staging the same clip twice does not load it again', () => {
    const { control, messages } = setup({ startClipId: 'quiet' })

    control.stage('loud')
    control.stage('loud')

    expect(messages).toHaveLength(1)
  })

  it('Go reaches the picture on the bar it armed, and not a frame before', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = setup({ now: clockNow.now, startClipId: 'quiet' })

    control.stage('loud')
    clockNow.set(2500)
    control.go()

    // 120bpm, 4 beats/bar → a 2000ms bar; 2500 sits mid-bar, so the next downbeat is 4000.
    expect(nextBarAt({ beatsPerBar: 4, bpm: 120, downbeatAt: 0 }, 2500)).toBe(4000)
    expect(control.getSnapshot().firingAt).toBe(4000)
    clockNow.set(3999)
    control.tick()
    expect(switches(messages)).toStrictEqual([])

    clockNow.set(4000)
    control.tick()
    expect(switches(messages)).toStrictEqual([{ at: 4000, kind: 'switch', to: 'b', transition: CUT_SPEC }])
  })

  it('Go now reaches the picture on the next frame, not the next bar', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = setup({ now: clockNow.now, startClipId: 'quiet' })

    control.stage('loud')
    clockNow.set(2500)
    control.goNow()
    control.tick()

    expect(messages.at(-1)).toStrictEqual({ at: 2500, kind: 'switch', to: 'b', transition: CUT_SPEC })
  })

  it('Go with nothing staged tells the picture nothing', () => {
    const { control, messages } = setup({ startClipId: 'quiet' })

    control.go()

    expect(messages).toStrictEqual([])
  })

  it('a crossfade reaches the picture once, carrying the bar it started on', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = setup({ now: clockNow.now, startClipId: 'quiet' })

    control.setTransition(FADE_SPEC)
    control.stage('loud')
    control.go()
    clockNow.set(2000)
    control.tick()
    clockNow.set(3000)
    control.tick()
    clockNow.set(6000)
    control.tick()

    expect(switches(messages)).toStrictEqual([{ at: 2000, kind: 'switch', to: 'b', transition: FADE_SPEC }])
    expect(control.getSnapshot().current.clipId).toBe('loud')
  })

  it('a transition changed between the press and the bar is the one that fires', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = setup({ now: clockNow.now, startClipId: 'quiet' })

    control.stage('loud')
    control.go()
    control.setTransition(FADE_SPEC)
    clockNow.set(2000)
    control.tick()

    expect(switches(messages)).toStrictEqual([{ at: 2000, kind: 'switch', to: 'b', transition: FADE_SPEC }])
  })

  it('Go now finishes a running crossfade with a cut rather than swallowing the press', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = setup({ now: clockNow.now, startClipId: 'quiet' })

    control.setTransition(FADE_SPEC)
    control.stage('loud')
    control.go()
    clockNow.set(2000)
    control.tick()
    expect(control.getSnapshot().next).toBeDefined()

    messages.length = 0
    clockNow.set(2500)
    control.goNow()

    expect(messages).toStrictEqual([{ at: 2500, kind: 'switch', to: 'b', transition: CUT_SPEC }])
    expect(control.getSnapshot().next).toBeUndefined()
  })

  it('Go mid-fade changes nothing and tells the picture nothing', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = setup({ now: clockNow.now, startClipId: 'quiet' })

    control.setTransition(FADE_SPEC)
    control.stage('loud')
    control.go()
    clockNow.set(2000)
    control.tick()
    expect(control.getSnapshot().fading).toBe(true)

    const { barPhase: _barPhase, now: _now, ...before } = control.getSnapshot()
    messages.length = 0
    clockNow.set(2500)
    control.go()

    const { barPhase: _barPhaseAfter, now: _nowAfter, ...after } = control.getSnapshot()
    expect(messages).toStrictEqual([])
    expect(after).toStrictEqual(before)
  })

  it('changing the transition mid-fade neither alters the running fade nor completes it early', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = setup({ now: clockNow.now, startClipId: 'quiet' })

    control.setTransition(FADE_SPEC)
    control.stage('loud')
    control.go()
    clockNow.set(2000)
    control.tick()
    expect(control.getSnapshot().fading).toBe(true)

    messages.length = 0
    control.setTransition(CUT_SPEC)

    expect(messages).toStrictEqual([])
    expect(control.getSnapshot().transition).toStrictEqual(FADE_SPEC)

    // A `cut`'s `bars` is 0: if the change had taken effect, the fade would be done on the next tick.
    clockNow.set(2500)
    control.tick()
    expect(control.getSnapshot().current.clipId).toBe('quiet')
    expect(control.getSnapshot().fading).toBe(true)
  })

  it('staging mid-fade loads nothing and does not change what the fade is blending into', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = setup({ now: clockNow.now, startClipId: 'quiet' })

    control.setTransition(FADE_SPEC)
    control.stage('loud')
    control.go()
    clockNow.set(2000)
    control.tick()

    messages.length = 0
    control.stage('quiet')

    expect(messages).toStrictEqual([])
    expect(control.getSnapshot().next?.clipId).toBe('loud')
  })

  it('ignores a tap arriving within 50ms of the previous one (a double-fire)', () => {
    const clockNow = createFakeNow(0)
    const { control } = setup({ now: clockNow.now })

    control.tap()
    // Within the debounce window — dropped, not a real second tap.
    clockNow.set(20)
    control.tap()
    // 500ms after the *first* tap. If the debounced tap at 20ms had counted,
    // the taps would be [0, 20, 500] and bpm would come out as 240, not 120.
    clockNow.set(500)
    control.tap()

    expect(control.getSnapshot().bpm).toBe(120)
  })

  it('a tap moves the one clock the compositor fades against', () => {
    const clockNow = createFakeNow(0)
    const clock = { beatsPerBar: 4, bpm: 120, downbeatAt: 0 }
    const { control } = setup({ clock, now: clockNow.now })

    control.tap()
    // 400ms apart → 150bpm.
    clockNow.set(400)
    control.tap()

    expect(control.getSnapshot().bpm).toBe(150)
    expect(clock).toStrictEqual({ beatsPerBar: 4, bpm: 150, downbeatAt: 400 })
  })

  it('tells subscribers at once when state changes, and only now and then when it does not', () => {
    const clockNow = createFakeNow(0)
    const { bare } = setup({ now: clockNow.now, startClipId: 'quiet' })
    const seen: unknown[] = []
    bare.subscribe((snapshot) => {
      seen.push(snapshot)
    })
    seen.length = 0

    for (let frame = 0; frame < 6; frame += 1) {
      clockNow.advance(16)
      bare.tick()
    }
    expect(seen.length).toBeLessThanOrEqual(1)

    bare.hold()
    expect(seen.length).toBeGreaterThanOrEqual(1)
    seen.length = 0
    clockNow.advance(100)
    bare.tick()
    expect(seen).toHaveLength(1)
  })
})

/**
 * The seam ADR 0004 exists for: a pure decision does not guarantee the renderer obeys it. These use
 * `createControl` bare and draw each frame by hand, because whether a slot has rendered is the point.
 */
describe('the picture obeys the reducer', () => {
  const bare = (options: CreateControlOptions = {}) => {
    const { messages, picture, ticks } = fakePicture()
    const control = createControl(picture, { startClipId: 'quiet', ...options })
    messages.length = 0
    return { control, messages, ticks }
  }

  it('a choice with time to render fires on the next bar, with no Go', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = bare({ now: clockNow.now })

    clockNow.set(1900)
    control.choose('loud')
    expect(messages).toStrictEqual([{ code: FIXTURES[1].code, kind: 'load', slot: 'b' }])
    expect(control.getSnapshot().firingAt).toBe(2000)

    clockNow.set(1916)
    control.tick()
    clockNow.set(1932)
    control.tick()
    clockNow.set(2000)
    control.tick()

    expect(switches(messages)).toStrictEqual([{ at: 2000, kind: 'switch', to: 'b', transition: CUT_SPEC }])
    expect(control.getSnapshot().current.clipId).toBe('loud')
  })

  it('a choice too close to the bar slips to the following bar rather than showing an unrendered slot', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = bare({ now: clockNow.now })

    clockNow.set(1999)
    control.choose('loud')
    clockNow.set(2000)
    control.tick()
    expect(switches(messages)).toStrictEqual([])
    expect(control.getSnapshot().firingAt).toBe(4000)

    clockNow.set(2016)
    control.tick()
    clockNow.set(4000)
    control.tick()
    expect(switches(messages)).toStrictEqual([{ at: 4000, kind: 'switch', to: 'b', transition: CUT_SPEC }])
  })

  it('one rendered frame is not enough: Hydra samples a buffer from before its last draw', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = bare({ now: clockNow.now })

    clockNow.set(1900)
    control.choose('loud')
    clockNow.set(1916)
    control.tick()
    clockNow.set(2000)
    control.tick()

    expect(switches(messages)).toStrictEqual([])
    expect(control.getSnapshot().firingAt).toBe(4000)
  })

  it('choosing again before the bar replaces the clip and keeps the bar', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = bare({ now: clockNow.now })

    clockNow.set(1000)
    control.choose('loud')
    clockNow.set(1100)
    control.choose('quiet')
    expect(control.getSnapshot().next?.clipId).toBe('quiet')
    expect(control.getSnapshot().firingAt).toBe(2000)

    clockNow.set(1116)
    control.tick()
    clockNow.set(1132)
    control.tick()
    clockNow.set(2000)
    control.tick()

    expect(messages.filter((call) => call.kind === 'load')).toHaveLength(2)
    expect(switches(messages)).toHaveLength(1)
    expect(control.getSnapshot().current.slot).toBe('b')
  })

  it('a choice during a fade is held, loads nothing until the landing, then fires on the next bar', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = bare({
      clips: [...FIXTURES, { code: 'third()', id: 'third', title: 'Third' }],
      now: clockNow.now,
    })

    control.setTransition(FADE_SPEC)
    control.choose('loud')
    control.tick()
    control.tick()
    clockNow.set(2000)
    control.tick()

    messages.length = 0
    clockNow.set(3000)
    control.choose('third')
    expect(control.getSnapshot()).toMatchObject({ chosenClipId: 'third', next: { clipId: 'loud' } })
    expect(messages).toStrictEqual([])

    clockNow.set(6000)
    control.tick()
    expect(control.getSnapshot()).toMatchObject({
      current: { clipId: 'loud' },
      firingAt: 8000,
      next: { clipId: 'third' },
    })
    expect(messages).toStrictEqual([{ code: 'third()', kind: 'load', slot: 'a' }])

    clockNow.set(6016)
    control.tick()
    clockNow.set(6032)
    control.tick()
    clockNow.set(8000)
    control.tick()
    expect(switches(messages)).toStrictEqual([{ at: 8000, kind: 'switch', to: 'a', transition: FADE_SPEC }])
  })

  it('a clip that will not compile costs its own switch and says so, and the show keeps playing', () => {
    const clockNow = createFakeNow(0)
    const errors = vi.spyOn(console, 'error').mockReturnValue()
    const { messages, picture } = fakePicture()
    const brokenPicture: Picture = {
      ...picture,
      load: (slot, code) => {
        if (code === 'broken()') {
          throw new SyntaxError('nope')
        }
        picture.load(slot, code)
      },
    }
    const control = createControl(brokenPicture, {
      clips: [...FIXTURES, { code: 'broken()', id: 'broken', title: 'Broken' }],
      now: clockNow.now,
      startClipId: 'quiet',
    })
    messages.length = 0

    clockNow.set(1000)
    expect(() => {
      control.choose('broken')
    }).not.toThrow()

    expect(control.getSnapshot()).toMatchObject({
      armed: false,
      current: { clipId: 'quiet' },
      next: undefined,
    })
    expect(control.getSnapshot().pictureFault).toContain('Broken did not load')

    control.choose('loud')
    expect(control.getSnapshot().pictureFault).toBeUndefined()
    errors.mockRestore()
  })

  it('a track step that will not compile is tried once, and the show keeps playing where it is', () => {
    const clockNow = createFakeNow(0)
    const errors = vi.spyOn(console, 'error').mockReturnValue()
    const { picture } = fakePicture()
    let attempts = 0
    const control = createControl(
      {
        ...picture,
        load: (slot, code) => {
          if (code === 'broken()') {
            attempts += 1
            throw new SyntaxError('nope')
          }
          picture.load(slot, code)
        },
      },
      { clips: FIXTURES, now: clockNow.now, startClipId: 'quiet' },
    )

    control.loadTrack({
      clips: [{ code: 'broken()', id: 'broken', title: 'Broken' }],
      id: 'track',
      steps: [{ bars: 4, clipId: 'broken', transition: CUT_SPEC }],
      title: 'Set',
    })
    for (let frame = 0; frame < 5; frame += 1) {
      control.tick()
    }

    expect(attempts).toBe(1)
    expect(control.getSnapshot()).toMatchObject({ current: { clipId: 'quiet' }, next: undefined })
    expect(control.getSnapshot().pictureFault).toContain('Broken did not load')
    errors.mockRestore()
  })

  it('a frame that throws does not stop the reducer, and is reported once', () => {
    const clockNow = createFakeNow(0)
    const errors = vi.spyOn(console, 'error').mockReturnValue()
    const { picture } = fakePicture()
    const control = createControl(
      {
        ...picture,
        tick: () => {
          throw new Error('uniform blew up')
        },
      },
      { now: clockNow.now, startClipId: 'quiet' },
    )

    control.tick()
    control.tick()

    expect(control.getSnapshot().pictureFault).toContain('uniform blew up')
    expect(errors).toHaveBeenCalledOnce()
    errors.mockRestore()
  })

  it('Freeze stops drawing and Blackout does not', () => {
    const clockNow = createFakeNow(0)
    const { control, ticks } = bare({ now: clockNow.now })

    control.tick()
    expect(ticks).toHaveLength(1)

    control.freeze()
    control.tick()
    expect(ticks).toHaveLength(1)

    control.blackout()
    expect(control.getSnapshot().panic).toBe('blackout')
    control.tick()
    expect(ticks).toHaveLength(2)
  })

  it('a clip chosen under Freeze fires on the first bar after it lifts and the slot has rendered', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = bare({ now: clockNow.now })

    control.freeze()
    clockNow.set(1000)
    control.choose('loud')
    clockNow.set(4000)
    control.tick()
    expect(switches(messages)).toStrictEqual([])
    expect(control.getSnapshot().current.clipId).toBe('quiet')

    control.freeze()
    clockNow.set(4016)
    control.tick()
    clockNow.set(4032)
    control.tick()
    clockNow.set(6000)
    control.tick()
    expect(switches(messages)).toStrictEqual([{ at: 6000, kind: 'switch', to: 'b', transition: CUT_SPEC }])
  })

  it('a panic restored after a reload is in force from the first frame', () => {
    const { control } = bare({ panic: 'blackout' })
    expect(control.getSnapshot().panic).toBe('blackout')
  })

  it('Back reloads the previous clip and waits for it to render before cutting', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = bare({ now: clockNow.now })

    control.stage('loud')
    control.goNow()
    control.tick()
    control.tick()
    control.tick()
    expect(control.getSnapshot().current.clipId).toBe('loud')

    messages.length = 0
    clockNow.set(500)
    control.back()
    expect(messages).toStrictEqual([{ code: FIXTURES[0].code, kind: 'load', slot: 'a' }])

    control.tick()
    expect(switches(messages)).toStrictEqual([])
    clockNow.set(516)
    control.tick()
    expect(switches(messages)).toStrictEqual([{ at: 516, kind: 'switch', to: 'a', transition: CUT_SPEC }])
  })
})

/**
 * Track playback. Every assertion here reads the reducer's own state through `getSnapshot()`
 * rather than the message log: the screen and the picture sit downstream of the SAME reducer, so a log
 * that agrees with the screen proves only that both share whatever bug the reducer has. Where a
 * picture call IS asserted it is because the call carries a value the snapshot does not — the bar a
 * switch fired on.
 */
const TRACK_CLIPS: readonly PlayableClip[] = [
  { code: 'osc(1).out()', id: 'one', title: 'One' },
  { code: 'osc(2).out()', id: 'two', title: 'Two' },
  { code: 'osc(3).out()', id: 'three', title: 'Three' },
]

const track = (steps: readonly TrackStep[]): LoadedTrack => ({
  clips: TRACK_CLIPS,
  id: 'track-1',
  steps,
  title: 'Opening set',
})

const cutTrack = (bars = 4): LoadedTrack =>
  track([
    { bars, clipId: 'one', transition: CUT_SPEC },
    { bars, clipId: 'two', transition: CUT_SPEC },
    { bars, clipId: 'three', transition: CUT_SPEC },
  ])

/** A control wired to a fake clock, with the track's clips known to it and a start clip outside the track. */
const trackControl = (clockNow: { now: () => number }) =>
  setup({
    clips: [...TRACK_CLIPS, { code: 'osc(9).out()', id: 'start', title: 'Start' }],
    now: clockNow.now,
    startClipId: 'start',
  })

describe('track playback', () => {
  it('staging the first step queues it without putting it on screen', () => {
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)

    control.loadTrack(cutTrack())

    const snapshot = control.getSnapshot()
    expect(snapshot.current.clipId).toBe('start')
    expect(snapshot.next?.clipId).toBe('one')
    expect(snapshot.track).toStrictEqual({
      autoAdvance: true,
      bars: 4,
      elapsedBars: 0,
      index: -1,
      length: 3,
      queued: 0,
      title: 'Opening set',
    })
  })

  it('Go puts the first item on screen and stages the second', () => {
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)
    control.loadTrack(cutTrack())

    clockNow.set(500)
    control.go()
    clockNow.set(2000)
    control.tick()

    expect(control.getSnapshot()).toMatchObject({
      current: { clipId: 'one' },
      next: { clipId: 'two' },
      track: { index: 0, queued: 1 },
    })
  })

  it('a second Go carries on in order rather than restarting or skipping', () => {
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)
    control.loadTrack(cutTrack())

    clockNow.set(500)
    control.go()
    clockNow.set(2000)
    control.tick()
    clockNow.set(2500)
    control.go()
    clockNow.set(4000)
    control.tick()

    expect(control.getSnapshot()).toMatchObject({
      current: { clipId: 'two' },
      next: { clipId: 'three' },
      track: { index: 1, queued: 2 },
    })
  })

  it('stages nothing past the last item, and keeps it playing — never stop the show', () => {
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)
    control.loadTrack(track([{ bars: 4, clipId: 'one', transition: CUT_SPEC }]))

    clockNow.set(500)
    control.go()
    clockNow.set(2000)
    control.tick()
    clockNow.set(20_000)
    control.tick()

    expect(control.getSnapshot().current.clipId).toBe('one')
    expect(control.getSnapshot().next).toBeUndefined()
    expect(control.getSnapshot().track).toMatchObject({ index: 0, queued: 0 })
  })

  it('applies each item’s own transition as it is staged', () => {
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)
    control.loadTrack(
      track([
        { bars: 4, clipId: 'one', transition: CUT_SPEC },
        { bars: 4, clipId: 'two', transition: FADE_SPEC },
      ]),
    )

    expect(control.getSnapshot().transition.kind).toBe('cut')

    clockNow.set(500)
    control.go()
    clockNow.set(2000)
    control.tick()

    expect(control.getSnapshot().transition.kind).toBe('crossfade')
  })

  it('auto-advances once the item has used up its bars (§7)', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = trackControl(clockNow)
    control.loadTrack(cutTrack(4))

    clockNow.set(500)
    control.go()
    clockNow.set(2000)
    control.tick()

    // 120bpm / 4 beats a bar = a 2000ms bar. Item one landed on the bar at 2000 and holds for
    // four bars, so the next switch must be armed for 10000 — and nobody pressed anything.
    clockNow.set(8000)
    control.tick()
    expect(control.getSnapshot().firingAt).toBe(10_000)
    expect(switches(messages).filter((call) => call.at === 10_000)).toStrictEqual([])

    clockNow.set(10_000)
    control.tick()
    expect(switches(messages).at(-1)).toMatchObject({ at: 10_000, transition: CUT_SPEC })
    expect(control.getSnapshot().current.clipId).toBe('two')
    expect(control.getSnapshot().track?.index).toBe(1)
  })

  it('measures an item’s bars from the bar its switch FIRED on, not from the end of its crossfade', () => {
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)
    control.loadTrack(
      track([
        { bars: 4, clipId: 'one', transition: FADE_SPEC },
        { bars: 4, clipId: 'two', transition: CUT_SPEC },
      ]),
    )

    clockNow.set(500)
    control.go()
    // The switch fires on the bar at 2000; the two-bar crossfade then runs until 6000.
    clockNow.set(2000)
    control.tick()
    expect(control.getSnapshot().fading).toBe(true)
    clockNow.set(6000)
    control.tick()
    expect(control.getSnapshot().current.clipId).toBe('one')

    // Four bars from 2000 is 10000. Measuring from 6000 (where the fade ENDED) would arm for
    // 14000 instead, and every crossfade in a set would push the track later.
    clockNow.set(8000)
    control.tick()
    expect(control.getSnapshot().firingAt).toBe(10_000)
  })

  it('with auto-advance off, the staged item waits for Go', () => {
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)
    control.loadTrack(cutTrack(4))

    clockNow.set(500)
    control.go()
    clockNow.set(2000)
    control.tick()
    control.setAutoAdvance(false)

    clockNow.set(60_000)
    control.tick()
    expect(control.getSnapshot().current.clipId).toBe('one')
    expect(control.getSnapshot().next?.clipId).toBe('two')

    control.go()
    clockNow.set(62_000)
    control.tick()
    expect(control.getSnapshot().current.clipId).toBe('two')
  })

  it('refuses Go, a transition change and a track change while a fade is running, changing nothing', () => {
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)
    control.loadTrack(
      track([
        { bars: 4, clipId: 'one', transition: FADE_SPEC },
        { bars: 4, clipId: 'two', transition: CUT_SPEC },
      ]),
    )

    clockNow.set(500)
    control.go()
    clockNow.set(3000)
    control.tick()
    expect(control.getSnapshot().fading).toBe(true)

    const during = control.getSnapshot()
    control.go()
    control.setTransition(CUT_SPEC)
    control.stage('three')
    control.loadTrack(cutTrack())

    const after = control.getSnapshot()
    expect(after.fading).toBe(true)
    expect(after).toMatchObject({
      current: during.current,
      next: during.next,
      transition: { kind: 'crossfade' },
    })
    expect(after.track).toStrictEqual(during.track)
  })

  it('the item the fade was already committed to still lands once the fade completes', () => {
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)
    control.loadTrack(
      track([
        { bars: 4, clipId: 'one', transition: FADE_SPEC },
        { bars: 4, clipId: 'two', transition: CUT_SPEC },
      ]),
    )

    clockNow.set(500)
    control.go()
    clockNow.set(3000)
    control.tick()
    control.go()

    clockNow.set(6000)
    control.tick()

    expect(control.getSnapshot().fading).toBe(false)
    expect(control.getSnapshot()).toMatchObject({
      current: { clipId: 'one' },
      next: { clipId: 'two' },
      track: { index: 0 },
    })
  })

  it('an item shorter than the transition into it lands late rather than being skipped', () => {
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)
    control.loadTrack(
      track([
        { bars: 1, clipId: 'one', transition: FADE_SPEC },
        { bars: 1, clipId: 'two', transition: CUT_SPEC },
      ]),
    )

    clockNow.set(500)
    control.go()
    // Item one fires at 2000 and fades until 6000 — by which point its single bar is long spent.
    clockNow.set(2000)
    control.tick()
    clockNow.set(6000)
    control.tick()

    expect(control.getSnapshot().track?.index).toBe(0)

    clockNow.set(8000)
    control.tick()
    expect(control.getSnapshot().current.clipId).toBe('two')
    expect(control.getSnapshot().track?.index).toBe(1)
  })

  it('a track loaded under an armed switch brings its own transition to that bar', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = trackControl(clockNow)

    control.stage('three')
    control.setTransition(FADE_SPEC)
    clockNow.set(500)
    control.go()

    control.loadTrack(cutTrack())
    expect(control.getSnapshot().transition.kind).toBe('cut')

    clockNow.set(2000)
    control.tick()
    expect(switches(messages)).toStrictEqual([{ at: 2000, kind: 'switch', to: 'b', transition: CUT_SPEC }])
  })

  it('Go now finishing a track fade lands the step before any subscriber hears of it', () => {
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)
    control.loadTrack(
      track(['one', 'two', 'three'].map((clipId) => ({ bars: 4, clipId, transition: FADE_SPEC }))),
    )
    clockNow.set(500)
    control.go()
    clockNow.set(2000)
    control.tick()
    clockNow.set(3000)
    control.tick()
    expect(control.getSnapshot()).toMatchObject({ fading: true, track: { index: -1 } })

    const heard: unknown[] = []
    control.subscribe(() => {
      heard.length = 0
    })
    control.subscribe((snapshot) => {
      heard.push({ current: snapshot.current.clipId, index: snapshot.track?.index })
    })
    control.goNow()

    expect(heard).toStrictEqual([{ current: 'one', index: 0 }])
  })

  it('loads each staged item, so the picture has its code', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = trackControl(clockNow)
    control.loadTrack(cutTrack())

    expect(messages).toStrictEqual([{ code: 'osc(1).out()', kind: 'load', slot: 'b' }])
  })

  it('names the clips by title, since a UUID on stage tells the performer nothing', () => {
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)
    control.loadTrack(cutTrack())

    expect(control.getSnapshot().nextTitle).toBe('One')

    clockNow.set(500)
    control.go()
    clockNow.set(2000)
    control.tick()

    expect(control.getSnapshot().currentTitle).toBe('One')
    expect(control.getSnapshot().nextTitle).toBe('Two')
  })

  it('has no title for a clip the panel was never given, rather than inventing one', () => {
    const { control } = setup({ clips: TRACK_CLIPS, startClipId: 'start' })

    // `startClipId` is 'start', which is in no clip list this control was handed.
    expect(control.getSnapshot().currentTitle).toBeUndefined()
  })

  it('reports a switch as armed between the press and the bar it lands on', () => {
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)
    control.loadTrack(cutTrack())

    expect(control.getSnapshot().armed).toBe(false)

    clockNow.set(500)
    control.go()
    // Pressed, but the bar has not come round yet — a panel showing only `fading` would look
    // exactly as it did before the press.
    expect(control.getSnapshot().armed).toBe(true)

    clockNow.set(2000)
    control.tick()
    expect(control.getSnapshot().armed).toBe(false)
  })

  it('clearing the track leaves what is on screen alone', () => {
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)
    control.loadTrack(cutTrack())
    clockNow.set(500)
    control.go()
    clockNow.set(2000)
    control.tick()

    control.clearTrack()

    expect(control.getSnapshot().track).toBeUndefined()
    expect(control.getSnapshot().current.clipId).toBe('one')
  })
})

/**
 * The panel disables a control exactly when the reducer would refuse it. These assert on the
 * SNAPSHOT — what the template actually binds `disabled` to — rather than on `PlaybackState`,
 * because the gap this closes was never in the reducer: it was between the reducer and the
 * surface. `packages/engines`'s own suite proves the predicates match `reduce`; this proves the
 * panel is wired to those predicates and not to a second reading of `fading`.
 */
describe('what the panel may offer', () => {
  const idle = () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = trackControl(clockNow)
    return { clockNow, control, messages }
  }

  it('refuses Go with nothing queued, and says why', () => {
    const { control } = idle()
    const snapshot = control.getSnapshot()

    expect(snapshot.canGo).toBe(false)
    expect(snapshot.fading).toBe(false)
    expect(controlHints(snapshot).go).toContain('Nothing is staged')
  })

  it('allows Go once something is queued, with nothing to explain', () => {
    const { control } = idle()
    control.stage('one')

    expect(control.getSnapshot().canGo).toBe(true)
    expect(controlHints(control.getSnapshot()).go).toBeUndefined()
  })

  it('refuses a second Go over an armed one, and says why — no fade involved', () => {
    const { clockNow, control } = idle()
    control.stage('one')
    clockNow.set(500)
    control.go()

    const snapshot = control.getSnapshot()
    expect(snapshot.fading).toBe(false)
    expect(snapshot.armed).toBe(true)
    expect(snapshot.canGo).toBe(false)
    expect(controlHints(snapshot).go).toContain('Armed')
  })

  it('mid-fade, refuses Go, queueing and the transition — but not Go now', () => {
    const { clockNow, control } = idle()
    control.loadTrack(
      track([
        { bars: 4, clipId: 'one', transition: FADE_SPEC },
        { bars: 4, clipId: 'two', transition: CUT_SPEC },
      ]),
    )
    clockNow.set(500)
    control.go()
    clockNow.set(2000)
    control.tick()

    const snapshot = control.getSnapshot()
    expect(snapshot.fading).toBe(true)
    expect({
      canGo: snapshot.canGo,
      canGoNow: snapshot.canGoNow,
      canQueue: snapshot.canQueue,
      canSetTransition: snapshot.canSetTransition,
    }).toStrictEqual({ canGo: false, canGoNow: true, canQueue: false, canSetTransition: false })
  })

  it('gives every mid-fade refusal a sentence, so no control is dead without a reason', () => {
    const { clockNow, control } = idle()
    control.loadTrack(track([{ bars: 4, clipId: 'one', transition: FADE_SPEC }]))
    clockNow.set(500)
    control.go()
    clockNow.set(2000)
    control.tick()

    const hints = controlHints(control.getSnapshot())
    const shown = [hints.back, hints.go, hints.track, hints.transition].filter((hint) => hint !== undefined)
    expect(shown).toHaveLength(4)
    expect(shown.every((hint) => hint.includes('Fade in progress'))).toBe(true)
  })

  it('explains nothing when everything is available', () => {
    const { control } = idle()
    control.stage('one')

    expect(controlHints(control.getSnapshot())).toStrictEqual({
      back: 'Nothing to go back to yet.',
      go: undefined,
      track: undefined,
      transition: undefined,
    })
  })
})

describe('transport controls', () => {
  it('Hold pauses auto-advance without stopping the clip, and releasing it lets the step come due', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = trackControl(clockNow)
    control.loadTrack(cutTrack(4))

    clockNow.set(500)
    control.go()
    clockNow.set(2000)
    control.tick()

    control.hold()
    const beforeHold = messages.length
    clockNow.set(8000)
    control.tick()
    clockNow.set(10_000)
    control.tick()

    expect(messages).toHaveLength(beforeHold)
    expect(control.getSnapshot().armed).toBe(false)
    expect(control.getSnapshot()).toMatchObject({
      current: { clipId: 'one' },
      held: true,
      track: { index: 0 },
    })

    control.hold()
    clockNow.set(10_001)
    control.tick()
    expect(control.getSnapshot().held).toBe(false)
    expect(control.getSnapshot().firingAt).toBe(12_000)
  })

  it('Back returns to the previous clip and rewinds the track cursor', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = trackControl(clockNow)
    control.loadTrack(cutTrack(4))

    clockNow.set(500)
    control.go()
    clockNow.set(2000)
    control.tick()
    clockNow.set(8000)
    control.tick()
    clockNow.set(10_000)
    control.tick()
    expect(control.getSnapshot()).toMatchObject({ current: { clipId: 'two' }, track: { index: 1 } })

    messages.length = 0
    control.back()

    expect(control.getSnapshot()).toMatchObject({ current: { clipId: 'one' }, track: { index: 0 } })
    expect(messages).toStrictEqual([{ code: 'osc(1).out()', kind: 'load', slot: 'b' }])
    control.tick()
    expect(switches(messages)).toStrictEqual([{ at: 10_000, kind: 'switch', to: 'b', transition: CUT_SPEC }])
  })

  it('overriding Next after the last track item leaves the cursor on that item', () => {
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)
    control.loadTrack(track([{ bars: 4, clipId: 'one', transition: CUT_SPEC }]))
    clockNow.set(500)
    control.go()
    clockNow.set(2000)
    control.tick()
    expect(control.getSnapshot().track).toMatchObject({ index: 0, length: 1, queued: 0 })

    control.stage('two')

    expect(control.getSnapshot().next?.clipId).toBe('two')
    expect(control.getSnapshot().track).toMatchObject({ index: 0, queued: 0 })
  })

  it('Back from a candidate played after the track ended returns to the last item and keeps the cursor on it', () => {
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)
    control.addClips([{ code: 'osc(9).out()', id: 'extra', title: 'Extra' }])
    control.loadTrack(cutTrack(4))
    for (const [pressed, landed] of [
      [500, 2000],
      [2500, 4000],
      [4500, 6000],
    ] as const) {
      clockNow.set(pressed)
      control.go()
      clockNow.set(landed)
      control.tick()
    }
    expect(control.getSnapshot()).toMatchObject({ current: { clipId: 'three' }, track: { index: 2 } })

    control.stage('extra')
    clockNow.set(6500)
    control.go()
    clockNow.set(8000)
    control.tick()
    expect(control.getSnapshot().current.clipId).toBe('extra')

    clockNow.set(8500)
    control.back()
    clockNow.set(8600)
    control.tick()

    expect(control.getSnapshot()).toMatchObject({
      current: { clipId: 'three' },
      next: undefined,
      track: { index: 2, queued: 2 },
    })
  })

  it('Back through several candidates played after the track ended returns to the last item one at a time', () => {
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)
    control.addClips([
      { code: 'osc(8).out()', id: 'extra-1', title: 'Extra 1' },
      { code: 'osc(9).out()', id: 'extra-2', title: 'Extra 2' },
    ])
    control.loadTrack(track([{ bars: 4, clipId: 'one', transition: CUT_SPEC }]))
    clockNow.set(500)
    control.go()
    clockNow.set(2000)
    control.tick()
    for (const [clipId, pressed, landed] of [
      ['extra-1', 2500, 4000],
      ['extra-2', 4500, 6000],
    ] as const) {
      control.stage(clipId)
      clockNow.set(pressed)
      control.go()
      clockNow.set(landed)
      control.tick()
    }
    expect(control.getSnapshot().current.clipId).toBe('extra-2')

    control.back()
    expect(control.getSnapshot()).toMatchObject({ current: { clipId: 'extra-1' }, track: { index: 0 } })
    control.back()
    expect(control.getSnapshot()).toMatchObject({ current: { clipId: 'one' }, track: { index: 0 } })
    control.back()
    expect(control.getSnapshot()).toMatchObject({ current: { clipId: 'start' }, track: undefined })
  })

  it('overriding Next mid-track makes the override the next item and carries on after it', () => {
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)
    control.loadTrack(cutTrack(4))
    clockNow.set(500)
    control.go()
    clockNow.set(2000)
    control.tick()

    control.stage('three')
    expect(control.getSnapshot()).toMatchObject({ next: { clipId: 'three' }, track: { index: 0, queued: 1 } })

    clockNow.set(2500)
    control.go()
    clockNow.set(4000)
    control.tick()
    expect(control.getSnapshot()).toMatchObject({
      current: { clipId: 'three' },
      track: { index: 1, queued: 2 },
    })
  })

  it('a Hold pressed while a switch is armed survives the landing', () => {
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)
    control.loadTrack(cutTrack(4))
    clockNow.set(500)
    control.go()
    control.hold()
    clockNow.set(2000)
    control.tick()

    expect(control.getSnapshot()).toMatchObject({ current: { clipId: 'one' }, held: true })
  })

  it('Blackout and Freeze report their panic state, for the screen to cover the picture', () => {
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)

    control.blackout()
    expect(control.getSnapshot().panic).toBe('blackout')

    control.freeze()
    expect(control.getSnapshot().panic).toBe('freeze')

    control.freeze()
    expect(control.getSnapshot().panic).toBe('none')
  })

  it('sets a transition with its own bar count, not just a kind', () => {
    const { control } = trackControl(createFakeNow(0))

    control.setTransition({ bars: 4, kind: 'crossfade' })

    expect(control.getSnapshot().transition).toStrictEqual({ bars: 4, kind: 'crossfade' })
  })
})
