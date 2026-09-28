// SPDX-License-Identifier: AGPL-3.0-or-later
import type { OutputMessage } from '@vev/shared'
import { describe, expect, it, vi } from 'vitest'

import { sendHello, subscribeOutput } from './output-client.ts'

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
