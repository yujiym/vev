// SPDX-License-Identifier: AGPL-3.0-or-later
import { FIXTURES, nextBarAt } from '@vev/engines'
import type { OutputMessage } from '@vev/shared'
import { describe, expect, it, vi } from 'vitest'

import type { LoadedTrack, PlayableClip, TrackStep } from './control.ts'
import { controlHints, createControl, startControl } from './control.ts'

/**
 * A fake `BroadcastChannel`, the same shape as `output-client.test.ts`'s:
 * only what `startControl` uses (`addEventListener`/`removeEventListener`
 * for `'message'`, `close`, `postMessage`), plus a `receive` helper to push a
 * raw payload the way another document's `postMessage` would.
 */
class FakeChannel {
  closed = false
  posted: unknown[] = []
  private listener: ((event: MessageEvent) => void) | undefined

  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void {
    if (type === 'message') {
      this.listener = listener
    }
  }

  removeEventListener(type: 'message', listener: (event: MessageEvent) => void): void {
    if (type === 'message' && this.listener === listener) {
      this.listener = undefined
    }
  }

  receive(data: unknown): void {
    this.listener?.({ data } as MessageEvent)
  }

  postMessage(data: unknown): void {
    this.posted.push(data)
  }

  close(): void {
    this.closed = true
  }
}

const createFrameScheduler = () => {
  let nextHandle = 0
  const pending = new Map<number, () => void>()
  return {
    cancelFrame: (handle: number) => {
      pending.delete(handle)
    },
    fire: () => {
      const runs = [...pending.values()]
      pending.clear()
      for (const run of runs) {
        run()
      }
    },
    requestFrame: (run: () => void) => {
      const handle = nextHandle
      nextHandle += 1
      pending.set(handle, run)
      return handle
    },
  }
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

describe(createControl, () => {
  it('queueing a clip publishes a load for the free slot', () => {
    const messages: OutputMessage[] = []
    const control = createControl(
      (message) => {
        messages.push(message)
      },
      { startClipId: 'quiet' },
    )

    control.queue('loud')

    expect(messages).toStrictEqual([
      { clip: { code: FIXTURES[1].code, id: 'loud' }, kind: 'load', slot: 'b' },
    ])
  })

  it('queueing the same clip twice does not re-publish a load', () => {
    const messages: OutputMessage[] = []
    const control = createControl(
      (message) => {
        messages.push(message)
      },
      { startClipId: 'quiet' },
    )

    control.queue('loud')
    control.queue('loud')

    expect(messages).toHaveLength(1)
  })

  it('Go publishes a switch whose at equals nextBarAt', () => {
    const clockNow = createFakeNow(0)
    const messages: OutputMessage[] = []
    const control = createControl(
      (message) => {
        messages.push(message)
      },
      {
        now: clockNow.now,
        startClipId: 'quiet',
      },
    )

    control.queue('loud')
    clockNow.set(2500)
    control.go()

    // 120bpm, 4 beats/bar → a 2000ms bar; 2500 sits mid-bar, so the next downbeat is 4000.
    const expectedAt = nextBarAt({ beatsPerBar: 4, bpm: 120, downbeatAt: 0 }, 2500)
    expect(expectedAt).toBe(4000)
    expect(messages.at(-1)).toStrictEqual({
      at: 4000,
      kind: 'switch',
      to: 'b',
      transition: { bars: 0, kind: 'cut' },
    })
  })

  it('Go now publishes a switch whose at is the moment pressed, not the next bar', () => {
    const clockNow = createFakeNow(0)
    const messages: OutputMessage[] = []
    const control = createControl(
      (message) => {
        messages.push(message)
      },
      {
        now: clockNow.now,
        startClipId: 'quiet',
      },
    )

    control.queue('loud')
    clockNow.set(2500)
    control.goNow()

    expect(messages.at(-1)).toStrictEqual({
      at: 2500,
      kind: 'switch',
      to: 'b',
      transition: { bars: 0, kind: 'cut' },
    })
  })

  it('Go with nothing queued publishes nothing', () => {
    const messages: OutputMessage[] = []
    const control = createControl(
      (message) => {
        messages.push(message)
      },
      { startClipId: 'quiet' },
    )

    control.go()

    expect(messages).toStrictEqual([])
  })

  it('Go now finishes a running crossfade immediately rather than swallowing the press', () => {
    const clockNow = createFakeNow(0)
    const messages: OutputMessage[] = []
    const control = createControl(
      (message) => {
        messages.push(message)
      },
      {
        now: clockNow.now,
        startClipId: 'quiet',
      },
    )

    control.setTransitionKind('crossfade')
    control.queue('loud')
    control.go()
    // Land on the armed bar (4000) so the fade begins.
    clockNow.set(4000)
    control.tick()
    expect(control.getSnapshot().next).toBeDefined()

    messages.length = 0
    clockNow.set(4500)
    control.goNow()

    expect(messages).toStrictEqual([
      { at: 4500, kind: 'switch', to: 'b', transition: { bars: 0, kind: 'cut' } },
    ])
    expect(control.getSnapshot().next).toBeUndefined()
  })

  it('Go mid-fade changes nothing and publishes nothing', () => {
    const clockNow = createFakeNow(0)
    const messages: OutputMessage[] = []
    const control = createControl(
      (message) => {
        messages.push(message)
      },
      { now: clockNow.now, startClipId: 'quiet' },
    )

    control.setTransitionKind('crossfade')
    control.queue('loud')
    control.go()
    // Land on the armed bar (2000) so the fade begins.
    clockNow.set(2000)
    control.tick()
    expect(control.getSnapshot().fading).toBe(true)

    const { barPhase: _barPhase, ...before } = control.getSnapshot()
    messages.length = 0
    clockNow.set(2500)
    control.go()

    const { barPhase: _barPhaseAfter, ...after } = control.getSnapshot()
    expect(messages).toStrictEqual([])
    expect(after).toStrictEqual(before)
  })

  it('toggling the transition kind mid-fade neither alters the running fade nor completes it early', () => {
    const clockNow = createFakeNow(0)
    const messages: OutputMessage[] = []
    const control = createControl(
      (message) => {
        messages.push(message)
      },
      { now: clockNow.now, startClipId: 'quiet' },
    )

    control.setTransitionKind('crossfade')
    control.queue('loud')
    control.go()
    // Land on the armed bar (2000) so the fade begins.
    clockNow.set(2000)
    control.tick()
    expect(control.getSnapshot().fading).toBe(true)

    messages.length = 0
    control.setTransitionKind('cut')

    expect(messages).toStrictEqual([])
    expect(control.getSnapshot().transitionKind).toBe('crossfade')

    // A `cut` transition's `bars` is 0 — if the toggle had taken effect, the
    // fade would already be done on the next tick. Confirm it is not.
    clockNow.set(2500)
    control.tick()
    expect(control.getSnapshot().current.clipId).toBe('quiet')
    expect(control.getSnapshot().fading).toBe(true)
  })

  it('queueing mid-fade publishes no load and does not change what the fade is blending into', () => {
    const clockNow = createFakeNow(0)
    const messages: OutputMessage[] = []
    const control = createControl(
      (message) => {
        messages.push(message)
      },
      { now: clockNow.now, startClipId: 'quiet' },
    )

    control.setTransitionKind('crossfade')
    control.queue('loud')
    control.go()
    // Land on the armed bar (2000) so the fade begins.
    clockNow.set(2000)
    control.tick()
    expect(control.getSnapshot().fading).toBe(true)
    expect(control.getSnapshot().next?.clipId).toBe('loud')

    messages.length = 0
    // Only 'quiet' and 'loud' exist as fixtures; re-queueing 'quiet' (the
    // clip currently playing) into the fade's destination slot is still a
    // distinct value from 'loud' and so still exercises the guard —
    // `fixtureById` would otherwise skip an unknown id before `reduce` is
    // ever reached, deciding nothing about the mid-fade behaviour at all.
    control.queue('quiet')

    expect(messages).toStrictEqual([])
    expect(control.getSnapshot().next?.clipId).toBe('loud')
  })

  it('hello mid-fade re-sends the transition the fade actually started with, even after a refused toggle attempt', () => {
    const clockNow = createFakeNow(0)
    const messages: OutputMessage[] = []
    const control = createControl(
      (message) => {
        messages.push(message)
      },
      { now: clockNow.now, startClipId: 'quiet' },
    )

    control.setTransitionKind('crossfade')
    control.queue('loud')
    control.go()
    // Land on the armed bar (2000) so the fade begins.
    clockNow.set(2000)
    control.tick()
    expect(control.getSnapshot().fading).toBe(true)

    // Refused — must not leak into the transition handleHello re-sends below.
    control.setTransitionKind('cut')

    messages.length = 0
    clockNow.set(2300)
    control.handleHello()

    expect(messages.at(-1)).toStrictEqual({
      at: 2000,
      kind: 'switch',
      to: 'b',
      transition: { bars: 2, kind: 'crossfade' },
    })
  })

  it('re-publishes the switch with the new transition and the same `at` when the toggle changes while armed', () => {
    const clockNow = createFakeNow(0)
    const messages: OutputMessage[] = []
    const control = createControl(
      (message) => {
        messages.push(message)
      },
      { now: clockNow.now, startClipId: 'quiet' },
    )

    control.queue('loud')
    clockNow.set(2500)
    control.go()
    const armed = messages.at(-1)
    expect(armed).toMatchObject({ at: 4000, kind: 'switch', transition: { kind: 'cut' } })

    messages.length = 0
    control.setTransitionKind('crossfade')

    expect(messages.at(-1)).toStrictEqual({
      at: 4000,
      kind: 'switch',
      to: 'b',
      transition: { bars: 2, kind: 'crossfade' },
    })
  })

  it('does not publish a switch when the toggle changes with nothing armed', () => {
    const messages: OutputMessage[] = []
    const control = createControl((message) => {
      messages.push(message)
    })

    control.setTransitionKind('crossfade')

    expect(messages).toStrictEqual([])
  })

  it('hello during an armed Go re-sends the pending switch with its original `at` and transition', () => {
    const clockNow = createFakeNow(1000)
    const messages: OutputMessage[] = []
    const control = createControl(
      (message) => {
        messages.push(message)
      },
      { now: clockNow.now, startClipId: 'quiet' },
    )

    control.setTransitionKind('crossfade')
    control.queue('loud')
    clockNow.set(1500)
    control.go()
    // downbeatAt=1000, 120bpm → a 2000ms bar; 1500 sits mid-bar, so the next
    // downbeat — and the armed `at` — is 3000.
    expect(control.getSnapshot().next).toBeDefined()

    messages.length = 0
    clockNow.set(1800)
    control.handleHello()

    expect(messages.at(-1)).toStrictEqual({
      at: 3000,
      kind: 'switch',
      to: 'b',
      transition: { bars: 2, kind: 'crossfade' },
    })
  })

  it("hello mid-fade re-sends a switch resuming from the fade's original startedAt", () => {
    const clockNow = createFakeNow(0)
    const messages: OutputMessage[] = []
    const control = createControl(
      (message) => {
        messages.push(message)
      },
      { now: clockNow.now, startClipId: 'quiet' },
    )

    control.setTransitionKind('crossfade')
    control.queue('loud')
    control.go()
    // Land on the armed bar (2000) so the fade begins.
    clockNow.set(2000)
    control.tick()
    expect(control.getSnapshot().next).toBeDefined()

    messages.length = 0
    clockNow.set(2300)
    control.handleHello()

    expect(messages.at(-1)).toStrictEqual({
      at: 2000,
      kind: 'switch',
      to: 'b',
      transition: { bars: 2, kind: 'crossfade' },
    })
  })

  it('answers hello with clock, a load per occupied slot, and a cut switch to the current slot', () => {
    const clockNow = createFakeNow(1000)
    const messages: OutputMessage[] = []
    const control = createControl(
      (message) => {
        messages.push(message)
      },
      {
        now: clockNow.now,
        startClipId: 'quiet',
      },
    )
    control.queue('loud')
    messages.length = 0

    control.handleHello()

    expect(messages).toStrictEqual([
      { beatsPerBar: 4, bpm: 120, downbeatAt: 1000, kind: 'clock' },
      { clip: { code: FIXTURES[0].code, id: 'quiet' }, kind: 'load', slot: 'a' },
      { clip: { code: FIXTURES[1].code, id: 'loud' }, kind: 'load', slot: 'b' },
      { at: 1000, kind: 'switch', to: 'a', transition: { bars: 0, kind: 'cut' } },
    ])
  })

  it('ignores a tap arriving within 50ms of the previous one (a double-fire)', () => {
    const clockNow = createFakeNow(0)
    const messages: OutputMessage[] = []
    const control = createControl(
      (message) => {
        messages.push(message)
      },
      { now: clockNow.now },
    )

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

  it('updates and publishes the tempo once enough taps have accumulated', () => {
    const clockNow = createFakeNow(0)
    const messages: OutputMessage[] = []
    const control = createControl(
      (message) => {
        messages.push(message)
      },
      { now: clockNow.now },
    )

    control.tap()
    // 400ms apart → 150bpm.
    clockNow.set(400)

    control.tap()

    expect(control.getSnapshot().bpm).toBe(150)
    expect(messages.at(-1)).toStrictEqual({ beatsPerBar: 4, bpm: 150, downbeatAt: 400, kind: 'clock' })
  })
})

describe(startControl, () => {
  it('answers an incoming hello on the given channel', () => {
    const channel = new FakeChannel()
    startControl({
      cancelFrame: vi.fn<(handle: number) => void>(),
      channel: channel as unknown as BroadcastChannel,
      requestFrame: vi.fn<(run: () => void) => number>(() => 0),
    })

    channel.posted.length = 0
    channel.receive({ kind: 'hello' })

    expect(channel.posted[0]).toMatchObject({ kind: 'clock' })
  })

  it('drops a malformed incoming message without throwing', () => {
    const channel = new FakeChannel()
    startControl({
      cancelFrame: vi.fn<(handle: number) => void>(),
      channel: channel as unknown as BroadcastChannel,
      requestFrame: vi.fn<(run: () => void) => number>(() => 0),
    })

    channel.posted.length = 0
    expect(() => {
      channel.receive({ kind: 'switch', to: 'not-a-slot' })
    }).not.toThrow()
    expect(channel.posted).toStrictEqual([])
  })

  it('drives tick from the frame loop and stops on teardown', () => {
    const channel = new FakeChannel()
    const scheduler = createFrameScheduler()
    const { stop } = startControl({
      cancelFrame: scheduler.cancelFrame,
      channel: channel as unknown as BroadcastChannel,
      requestFrame: scheduler.requestFrame,
    })

    scheduler.fire()
    scheduler.fire()
    stop()
    scheduler.fire()

    expect(channel.closed).toBe(true)
  })
})

/**
 * Track playback. Every assertion here reads the reducer's own state through `getSnapshot()`
 * rather than the message log: the panel and the output window sit downstream of the SAME
 * reducer, so a log that agrees with the panel proves only that both share whatever bug the
 * reducer has. Where a message IS asserted it is because the message carries a value the
 * snapshot does not — the bar a switch was armed for.
 */
const TRACK_CLIPS: readonly PlayableClip[] = [
  { code: 'osc(1).out()', id: 'one', title: 'One' },
  { code: 'osc(2).out()', id: 'two', title: 'Two' },
  { code: 'osc(3).out()', id: 'three', title: 'Three' },
]

const CUT_SPEC = { bars: 0, kind: 'cut' } as const
const FADE_SPEC = { bars: 2, kind: 'crossfade' } as const

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
const trackControl = (clockNow: { now: () => number }) => {
  const messages: OutputMessage[] = []
  const control = createControl(
    (message) => {
      messages.push(message)
    },
    { clips: TRACK_CLIPS, now: clockNow.now, startClipId: 'start' },
  )
  return { control, messages }
}

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

    expect(control.getSnapshot().transitionKind).toBe('cut')

    clockNow.set(500)
    control.go()
    clockNow.set(2000)
    control.tick()

    expect(control.getSnapshot().transitionKind).toBe('crossfade')
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
    expect(messages.at(-1)).toStrictEqual({ at: 10_000, kind: 'switch', to: 'a', transition: CUT_SPEC })

    clockNow.set(10_000)
    control.tick()
    expect(control.getSnapshot().current.clipId).toBe('two')
    expect(control.getSnapshot().track?.index).toBe(1)
  })

  it('measures an item’s bars from the bar its switch FIRED on, not from the end of its crossfade', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = trackControl(clockNow)
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
    expect(messages.at(-1)).toMatchObject({ at: 10_000, kind: 'switch' })
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
    control.setTransitionKind('cut')
    control.queue('three')
    control.loadTrack(cutTrack())

    const after = control.getSnapshot()
    expect(after.fading).toBe(true)
    expect(after).toMatchObject({
      current: during.current,
      next: during.next,
      transitionKind: 'crossfade',
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

  it('re-publishes the armed switch when loading a track changes the transition under it', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = trackControl(clockNow)

    // A manual pick, armed with a crossfade — the output window has already been told to fade.
    control.queue('three')
    control.setTransitionKind('crossfade')
    clockNow.set(500)
    control.go()
    expect(messages.at(-1)).toMatchObject({ kind: 'switch', transition: FADE_SPEC })

    // Loading a track inside that window re-stages the slot with step 0's own transition. The
    // reducer accepts the change, so the output window must be told, or it executes the fade the
    // panel no longer believes in.
    control.loadTrack(cutTrack())

    expect(control.getSnapshot().transitionKind).toBe('cut')
    expect(messages.at(-1)).toStrictEqual({ at: 2000, kind: 'switch', to: 'b', transition: CUT_SPEC })
  })

  it('a manual queue that the reducer accepts leaves the track', () => {
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)
    control.loadTrack(cutTrack())

    control.queue('three')

    expect(control.getSnapshot().track).toBeUndefined()
    expect(control.getSnapshot().next?.clipId).toBe('three')
  })

  it('publishes a load for each staged item, so the output window has its code', () => {
    const clockNow = createFakeNow(0)
    const { control, messages } = trackControl(clockNow)
    control.loadTrack(cutTrack())

    expect(messages).toStrictEqual([{ clip: { code: 'osc(1).out()', id: 'one' }, kind: 'load', slot: 'b' }])
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
    const clockNow = createFakeNow(0)
    const { control } = trackControl(clockNow)

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
    expect(controlHints(snapshot).go).toContain('Nothing is queued')
  })

  it('allows Go once something is queued, with nothing to explain', () => {
    const { control } = idle()
    control.queue('one')

    expect(control.getSnapshot().canGo).toBe(true)
    expect(controlHints(control.getSnapshot()).go).toBeUndefined()
  })

  it('refuses a second Go over an armed one, and says why — no fade involved', () => {
    const { clockNow, control } = idle()
    control.queue('one')
    clockNow.set(500)
    control.go()

    const snapshot = control.getSnapshot()
    expect(snapshot.fading).toBe(false)
    expect(snapshot.armed).toBe(true)
    expect(snapshot.canGo).toBe(false)
    expect(controlHints(snapshot).go).toContain('armed')
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
    const shown = [hints.go, hints.queue, hints.track, hints.transition].filter((hint) => hint !== undefined)
    expect(shown).toHaveLength(4)
    expect(shown.every((hint) => hint.includes('Fade in progress'))).toBe(true)
  })

  it('explains nothing when everything is available', () => {
    const { control } = idle()
    control.queue('one')

    expect(controlHints(control.getSnapshot())).toStrictEqual({
      go: undefined,
      queue: undefined,
      track: undefined,
      transition: undefined,
    })
  })
})
