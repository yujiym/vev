// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OutputMessage, Slot, TransitionSpec } from '@vev/shared'
import { describe, expect, it, vi } from 'vitest'

import type { Compositor } from './output-client.ts'
import { sendHello, startOutput, subscribeOutput } from './output-client.ts'

/**
 * A fake `BroadcastChannel` that only implements what `subscribeOutput` and
 * `sendHello` use (`addEventListener`/`removeEventListener` for `'message'`,
 * `close`, `postMessage`), plus a `receive` helper so tests can push a raw,
 * untyped payload the same way another document's `postMessage` would.
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

describe(subscribeOutput, () => {
  it('routes a valid load message to the load handler', () => {
    const channel = new FakeChannel()
    const onLoad = vi.fn<() => void>()
    subscribeOutput(
      { onClock: vi.fn<() => void>(), onLoad, onSwitch: vi.fn<() => void>() },
      channel as unknown as BroadcastChannel,
    )

    const message: OutputMessage = {
      clip: { code: 'osc().out()', id: 'nine-lives' },
      kind: 'load',
      slot: 'b',
    }
    channel.receive(message)

    expect(onLoad).toHaveBeenCalledWith(message)
  })

  it('routes a valid switch message to the switch handler with its at intact', () => {
    const channel = new FakeChannel()
    const onSwitch = vi.fn<() => void>()
    subscribeOutput(
      { onClock: vi.fn<() => void>(), onLoad: vi.fn<() => void>(), onSwitch },
      channel as unknown as BroadcastChannel,
    )

    const message: OutputMessage = {
      at: 1_758_999_123,
      kind: 'switch',
      to: 'a',
      transition: { bars: 2, kind: 'crossfade' },
    }
    channel.receive(message)

    expect(onSwitch).toHaveBeenCalledWith(message)
  })

  it('drops a malformed message without throwing', () => {
    const channel = new FakeChannel()
    const onLoad = vi.fn<() => void>()
    const onSwitch = vi.fn<() => void>()
    subscribeOutput(
      { onClock: vi.fn<() => void>(), onLoad, onSwitch },
      channel as unknown as BroadcastChannel,
    )

    expect(() => {
      channel.receive({ kind: 'load', slot: 'not-a-slot' })
    }).not.toThrow()
    expect(onLoad).not.toHaveBeenCalled()
    expect(onSwitch).not.toHaveBeenCalled()
  })

  it('does not let a throwing handler kill the channel for later messages', () => {
    const channel = new FakeChannel()
    const onSwitch = vi.fn<() => void>()
    const onLoad = vi.fn<() => void>(() => {
      throw new Error('boom')
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {
      // Silence the deliberate error log for this test; assertions below
      // check the *behavior* (delivery keeps working), not the log itself.
    })
    subscribeOutput(
      { onClock: vi.fn<() => void>(), onLoad, onSwitch },
      channel as unknown as BroadcastChannel,
    )

    const loadMessage: OutputMessage = {
      clip: { code: 'osc().out()', id: 'throws' },
      kind: 'load',
      slot: 'a',
    }
    const switchMessage: OutputMessage = {
      at: 1_758_999_999,
      kind: 'switch',
      to: 'b',
      transition: { bars: 0, kind: 'cut' },
    }
    channel.receive(loadMessage)
    channel.receive(switchMessage)

    expect(onLoad).toHaveBeenCalledWith(loadMessage)
    expect(onSwitch).toHaveBeenCalledWith(switchMessage)
    errorSpy.mockRestore()
  })

  it('stops delivery after unsubscribing', () => {
    const channel = new FakeChannel()
    const onLoad = vi.fn<() => void>()
    const unsubscribe = subscribeOutput(
      { onClock: vi.fn<() => void>(), onLoad, onSwitch: vi.fn<() => void>() },
      channel as unknown as BroadcastChannel,
    )

    unsubscribe()
    channel.receive({ clip: { code: 'osc().out()', id: 'after-unsub' }, kind: 'load', slot: 'a' })

    expect(onLoad).not.toHaveBeenCalled()
    expect(channel.closed).toBe(true)
  })
})

describe(sendHello, () => {
  it('posts a hello message on the given channel', () => {
    const channel = new FakeChannel()

    sendHello(channel as unknown as BroadcastChannel)

    expect(channel.posted).toStrictEqual([{ kind: 'hello' }])
  })
})

const createFakeCompositor = (): Compositor & {
  disposeCalls: () => number
  tickCalls: () => number[]
} => {
  const tickCalls: number[] = []
  let disposeCalls = 0
  return {
    dispose: () => {
      disposeCalls += 1
    },
    disposeCalls: () => disposeCalls,
    load: vi.fn<(slot: Slot, code: string) => void>(),
    mount: vi.fn<(canvas: HTMLCanvasElement) => void>(),
    resize: vi.fn<(width: number, height: number) => void>(),
    switchTo: vi.fn<(slot: Slot, spec: TransitionSpec, at: number) => void>(),
    tick: (at: number) => {
      tickCalls.push(at)
    },
    tickCalls: () => tickCalls,
  }
}

/** A controllable stand-in for `requestAnimationFrame`: `fire()` runs every pending frame and clears them, the same way a real frame would, but only when the test asks. */
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

const fakeCanvas = (): HTMLCanvasElement => ({ height: 0, width: 0 }) as unknown as HTMLCanvasElement
const noResize = (): (() => void) => () => {}
const fixedViewport = () => ({ height: 540, width: 960 })

describe(startOutput, () => {
  it("advances the compositor's tick with wall-clock times from the frame loop", async () => {
    const compositor = createFakeCompositor()
    const scheduler = createFrameScheduler()
    const times = [4_242_000, 4_242_016, 4_242_032]
    let call = 0
    const now = (): number => {
      const time = times[call]
      call += 1
      return time ?? times.at(-1) ?? 0
    }

    const canvas = fakeCanvas()
    startOutput({
      cancelFrame: scheduler.cancelFrame,
      canvas,
      channel: new FakeChannel() as unknown as BroadcastChannel,
      createCompositor: () => compositor,
      now,
      requestFrame: scheduler.requestFrame,
      subscribeResize: noResize,
      viewportSize: fixedViewport,
    })
    await vi.waitFor(() => {
      expect(compositor.mount).toHaveBeenCalledWith(canvas)
    })

    scheduler.fire()
    scheduler.fire()

    expect(compositor.tickCalls()).toStrictEqual([4_242_016, 4_242_032])
  })

  it('stops the loop and disposes exactly once on teardown', async () => {
    const compositor = createFakeCompositor()
    const scheduler = createFrameScheduler()

    const canvas = fakeCanvas()
    const teardown = startOutput({
      cancelFrame: scheduler.cancelFrame,
      canvas,
      channel: new FakeChannel() as unknown as BroadcastChannel,
      createCompositor: () => compositor,
      requestFrame: scheduler.requestFrame,
      subscribeResize: noResize,
      viewportSize: fixedViewport,
    })
    await vi.waitFor(() => {
      expect(compositor.mount).toHaveBeenCalledWith(canvas)
    })

    teardown()
    teardown()
    scheduler.fire()

    expect(compositor.tickCalls()).toStrictEqual([])
    expect(compositor.disposeCalls()).toBe(1)
  })

  it('does not leave the first compositor running after a second start', async () => {
    const first = createFakeCompositor()
    const second = createFakeCompositor()
    const scheduler = createFrameScheduler()
    const firstCanvas = fakeCanvas()
    const secondCanvas = fakeCanvas()
    const start = (compositor: Compositor, canvas: HTMLCanvasElement): (() => void) =>
      startOutput({
        cancelFrame: scheduler.cancelFrame,
        canvas,
        channel: new FakeChannel() as unknown as BroadcastChannel,
        createCompositor: () => compositor,
        requestFrame: scheduler.requestFrame,
        subscribeResize: noResize,
        viewportSize: fixedViewport,
      })

    const stopFirst = start(first, firstCanvas)
    await vi.waitFor(() => {
      expect(first.mount).toHaveBeenCalledWith(firstCanvas)
    })
    stopFirst()

    start(second, secondCanvas)
    await vi.waitFor(() => {
      expect(second.mount).toHaveBeenCalledWith(secondCanvas)
    })
    scheduler.fire()

    expect(first.tickCalls()).toStrictEqual([])
    expect(second.tickCalls()).toHaveLength(1)
  })

  it('holds a switch until its `at` arrives, rather than applying it at message-receipt time', async () => {
    const compositor = createFakeCompositor()
    const scheduler = createFrameScheduler()
    const channel = new FakeChannel()
    let currentTime = 1000
    const now = (): number => currentTime

    const canvas = fakeCanvas()
    startOutput({
      cancelFrame: scheduler.cancelFrame,
      canvas,
      channel: channel as unknown as BroadcastChannel,
      createCompositor: () => compositor,
      now,
      requestFrame: scheduler.requestFrame,
      subscribeResize: noResize,
      viewportSize: fixedViewport,
    })
    await vi.waitFor(() => {
      expect(compositor.mount).toHaveBeenCalledWith(canvas)
    })

    const message: OutputMessage = {
      at: 2000,
      kind: 'switch',
      to: 'b',
      transition: { bars: 0, kind: 'cut' },
    }
    channel.receive(message)

    currentTime = 1500
    scheduler.fire()
    expect(compositor.switchTo).not.toHaveBeenCalled()

    currentTime = 2000
    scheduler.fire()
    expect(compositor.switchTo).toHaveBeenCalledWith('b', message.transition, 2000)
  })

  it('supersedes a pending switch: only the latest message received before `at` reaches the compositor', async () => {
    const compositor = createFakeCompositor()
    const scheduler = createFrameScheduler()
    const channel = new FakeChannel()
    let currentTime = 1000
    const now = (): number => currentTime

    const canvas = fakeCanvas()
    startOutput({
      cancelFrame: scheduler.cancelFrame,
      canvas,
      channel: channel as unknown as BroadcastChannel,
      createCompositor: () => compositor,
      now,
      requestFrame: scheduler.requestFrame,
      subscribeResize: noResize,
      viewportSize: fixedViewport,
    })
    await vi.waitFor(() => {
      expect(compositor.mount).toHaveBeenCalledWith(canvas)
    })

    const first: OutputMessage = { at: 2000, kind: 'switch', to: 'b', transition: { bars: 0, kind: 'cut' } }
    channel.receive(first)
    const second: OutputMessage = {
      at: 2000,
      kind: 'switch',
      to: 'a',
      transition: { bars: 2, kind: 'crossfade' },
    }
    channel.receive(second)

    currentTime = 2000
    scheduler.fire()

    expect(compositor.switchTo).toHaveBeenCalledExactlyOnceWith('a', second.transition, 2000)
  })

  it('applies an already-due pending switch before a second switch replaces it (the `handleHello` double-switch)', async () => {
    const compositor = createFakeCompositor()
    const scheduler = createFrameScheduler()
    const channel = new FakeChannel()
    const currentTime = 5000
    const now = (): number => currentTime

    const canvas = fakeCanvas()
    startOutput({
      cancelFrame: scheduler.cancelFrame,
      canvas,
      channel: channel as unknown as BroadcastChannel,
      createCompositor: () => compositor,
      now,
      requestFrame: scheduler.requestFrame,
      subscribeResize: noResize,
      viewportSize: fixedViewport,
    })
    await vi.waitFor(() => {
      expect(compositor.mount).toHaveBeenCalledWith(canvas)
    })

    // The restore-cut `handleHello` sends first, `at` already due (its own
    // publish moment). Received here with no frame in between, matching two
    // `publish` calls in the same synchronous `handleHello`.
    const restoreCut: OutputMessage = {
      at: 5000,
      kind: 'switch',
      to: 'a',
      transition: { bars: 0, kind: 'cut' },
    }
    channel.receive(restoreCut)
    // The resumed crossfade, `at` set to when the fade actually started —
    // in the past relative to `now`, also already due.
    const resumeFade: OutputMessage = {
      at: 4000,
      kind: 'switch',
      to: 'b',
      transition: { bars: 2, kind: 'crossfade' },
    }
    channel.receive(resumeFade)

    expect(compositor.switchTo).toHaveBeenCalledOnce()
    expect(compositor.switchTo).toHaveBeenNthCalledWith(1, 'a', restoreCut.transition, 5000)

    scheduler.fire()

    expect(compositor.switchTo).toHaveBeenCalledTimes(2)
    expect(compositor.switchTo).toHaveBeenNthCalledWith(2, 'b', resumeFade.transition, 4000)
  })

  it('logs and reports a startup failure instead of leaving a silent black window', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('GL context creation failed')
    const scheduler = createFrameScheduler()
    const canvas = fakeCanvas()
    const onStartupError = vi.fn<() => void>()

    startOutput({
      cancelFrame: scheduler.cancelFrame,
      canvas,
      channel: new FakeChannel() as unknown as BroadcastChannel,
      createCompositor: () => {
        throw failure
      },
      onStartupError,
      requestFrame: scheduler.requestFrame,
      subscribeResize: noResize,
      viewportSize: fixedViewport,
    })

    await vi.waitFor(() => {
      expect(onStartupError).toHaveBeenCalledOnce()
    })
    expect(consoleError).toHaveBeenCalledWith('vev: output failed to start', failure)
    // No frame is ever scheduled for a compositor that never mounted.
    expect(scheduler.fire).not.toThrow()

    consoleError.mockRestore()
  })
})
