// SPDX-License-Identifier: AGPL-3.0-or-later
import { FIXTURES, nextBarAt } from '@vev/engines'
import type { OutputMessage } from '@vev/shared'
import { describe, expect, it, vi } from 'vitest'

import { createControl, startControl } from './control.ts'

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
