// SPDX-License-Identifier: AGPL-3.0-or-later
import { OUTPUT_CHANNEL, outputMessageSchema } from '@vev/shared'
import type { OutputMessage } from '@vev/shared'
import * as v from 'valibot'

type ClockMessage = Extract<OutputMessage, { kind: 'clock' }>
type LoadMessage = Extract<OutputMessage, { kind: 'load' }>
type SwitchMessage = Extract<OutputMessage, { kind: 'switch' }>

export interface OutputHandlers {
  onClock: (message: ClockMessage) => void
  onLoad: (message: LoadMessage) => void
  onSwitch: (message: SwitchMessage) => void
}

/**
 * Subscribes to `OUTPUT_CHANNEL` and routes incoming messages to `handlers`.
 *
 * Every message is untrusted input — it may come from any other document
 * sharing this origin — so it is parsed through `outputMessageSchema` before
 * anything is done with it; a message that fails to parse is dropped, not
 * thrown. The whole dispatch is wrapped in a `try`/`catch` too, because a
 * handler itself throwing out of `onmessage` would otherwise kill the
 * channel silently for the rest of the show (no more messages would ever be
 * delivered, with no error visible anywhere).
 *
 * `hello` is not routed here: it travels output→control only, so the output
 * window never receives one — see `sendHello`.
 *
 * Returns an unsubscribe function that detaches the listener and closes the
 * channel.
 */
export const subscribeOutput = (
  handlers: OutputHandlers,
  channel: BroadcastChannel = new BroadcastChannel(OUTPUT_CHANNEL),
): (() => void) => {
  const onMessage = (event: MessageEvent): void => {
    try {
      const result = v.safeParse(outputMessageSchema, event.data)
      if (!result.success) {
        return
      }

      const message = result.output
      if (message.kind === 'load') {
        handlers.onLoad(message)
      } else if (message.kind === 'switch') {
        handlers.onSwitch(message)
      } else if (message.kind === 'clock') {
        handlers.onClock(message)
      }
    } catch (error) {
      // A handler throwing here must not kill the channel for the rest of the
      // show — surface it for debugging and keep listening.
      console.error('vev: output-client handler failed', error)
    }
  }

  channel.addEventListener('message', onMessage)

  return () => {
    channel.removeEventListener('message', onMessage)
    channel.close()
  }
}

/**
 * Announces this output window to the control window, per `outputMessageSchema`'s
 * `hello`. Sent once when the window opens, so a projector that reloads mid-set
 * gets restored instead of showing black until the next switch (spec §0). Only
 * sends — the control window's reply is Task 5's responsibility.
 */
export const sendHello = (channel: BroadcastChannel = new BroadcastChannel(OUTPUT_CHANNEL)): void => {
  // BroadcastChannel.postMessage takes a single argument — unlike
  // Window.postMessage, it has no `targetOrigin` parameter to require; delivery
  // is scoped to same-origin listeners on this channel name by the API itself.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  channel.postMessage({ kind: 'hello' } satisfies OutputMessage)
}
