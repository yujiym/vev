// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Clock } from '@vev/engines'
import { OUTPUT_CHANNEL, outputMessageSchema } from '@vev/shared'
import type { OutputMessage, Slot, TransitionSpec } from '@vev/shared'
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
 *
 * Takes an explicit `channel` in `startOutput` below, rather than opening its
 * own: two independent `new BroadcastChannel(OUTPUT_CHANNEL)` calls are two
 * independent handles, and only one of them would ever get closed by
 * `subscribeOutput`'s teardown — the other leaks for the life of the tab.
 */
export const sendHello = (channel: BroadcastChannel = new BroadcastChannel(OUTPUT_CHANNEL)): void => {
  // BroadcastChannel.postMessage takes a single argument — unlike
  // Window.postMessage, it has no `targetOrigin` parameter to require; delivery
  // is scoped to same-origin listeners on this channel name by the API itself.
  // oxlint-disable-next-line unicorn/require-post-message-target-origin
  channel.postMessage({ kind: 'hello' } satisfies OutputMessage)
}

/**
 * The subset of `HydraCompositor` (`@vev/engines/hydra`) that `startOutput`
 * drives. Declared here, not imported from there, so this module — and its
 * tests — never touch `hydra-synth` or `window` at import time; a fake
 * satisfying this interface is all a test needs.
 */
export interface Compositor {
  dispose: () => void
  load: (slot: Slot, code: string) => void
  mount: (canvas: HTMLCanvasElement) => void
  resize: (width: number, height: number) => void
  switchTo: (slot: Slot, spec: TransitionSpec, at: number) => void
  tick: (now: number) => void
}

export interface StartOutputOptions {
  /** Cancels a handle returned by `requestFrame`. Defaults to `cancelAnimationFrame`. */
  cancelFrame?: (handle: number) => void
  /** The canvas the compositor renders into. */
  canvas: HTMLCanvasElement
  /** Defaults to a fresh `BroadcastChannel(OUTPUT_CHANNEL)`, closed on teardown. */
  channel?: BroadcastChannel
  /**
   * Builds the compositor against a live `Clock`. Defaults to a dynamic
   * `import('@vev/engines/hydra')` — never a static one, per spec §3: that
   * subpath touches `window` at module load time, so only browser code (in
   * practice, only this function) may import it, and only once actually
   * called.
   */
  createCompositor?: (clock: Clock) => Compositor | Promise<Compositor>
  /** Wall-clock now, per spec: `Date.now()`, never `performance.now()`. */
  now?: () => number
  /** Schedules one frame. Defaults to `requestAnimationFrame`, adapted to ignore its timestamp argument (`tick` uses `now()` instead — see the module doc above). */
  requestFrame?: (run: () => void) => number
  /** Subscribes to viewport-size changes; returns an unsubscribe function. Defaults to a `window` `'resize'` listener. */
  subscribeResize?: (onResize: (width: number, height: number) => void) => () => void
  /** The initial canvas size. Defaults to the window's current inner size. */
  viewportSize?: () => { height: number; width: number }
}

const defaultCreateCompositor = async (clock: Clock): Promise<Compositor> => {
  const { HydraCompositor } = await import('@vev/engines/hydra')
  return new HydraCompositor(clock)
}

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

const defaultViewportSize = () => ({
  height: window.innerHeight,
  width: window.innerWidth,
})

/**
 * Starts the output window's whole render loop: builds a compositor, wires it
 * to `OUTPUT_CHANNEL` via `subscribeOutput`, drives `tick` from
 * `requestFrame`, keeps it sized to the viewport via `resize` (never by
 * mutating the canvas's `width`/`height` directly — see `Compositor.resize`'s
 * doc comment in `@vev/engines/hydra`'s `HydraCompositor`, which is what a
 * bare canvas-size mutation would desync), announces this window with
 * `sendHello`, and returns a teardown that stops all of it.
 *
 * This is the entire orchestration the output route needs — kept here,
 * rather than in `+page.svelte`'s `$effect`, because `.svelte` is outside the
 * type and lint gate (ADR 0001) and this task's own defect (a resize handler
 * that broke rendering on the first fullscreen toggle) was only possible
 * because that logic lived somewhere nothing could check it.
 */
export const startOutput = (options: StartOutputOptions): (() => void) => {
  const {
    cancelFrame = cancelAnimationFrame,
    canvas,
    channel = new BroadcastChannel(OUTPUT_CHANNEL),
    createCompositor = defaultCreateCompositor,
    now = Date.now,
    requestFrame = defaultRequestFrame,
    subscribeResize = defaultSubscribeResize,
    viewportSize = defaultViewportSize,
  } = options

  let stopped = false
  let disposed = false
  let frame: number | undefined
  let compositor: Compositor | undefined

  // A mutable object, not a value copied into the compositor: `onClock` below
  // mutates its fields in place, so a tempo change is visible to the
  // compositor's next `fadeProgress` call without reconstructing it.
  const clock: Clock = { beatsPerBar: 4, bpm: 120, downbeatAt: now() }

  const size = viewportSize()
  canvas.width = size.width
  canvas.height = size.height

  const unsubscribe = subscribeOutput(
    {
      onClock: (message) => {
        clock.beatsPerBar = message.beatsPerBar
        clock.bpm = message.bpm
        clock.downbeatAt = message.downbeatAt
      },
      onLoad: (message) => {
        compositor?.load(message.slot, message.clip.code)
      },
      onSwitch: (message) => {
        compositor?.switchTo(message.to, message.transition, message.at)
      },
    },
    channel,
  )

  const unsubscribeResize = subscribeResize((width, height) => {
    compositor?.resize(width, height)
  })

  const loop = (): void => {
    compositor?.tick(now())
    frame = requestFrame(loop)
  }

  const disposeOnce = (): void => {
    if (!disposed) {
      disposed = true
      compositor?.dispose()
    }
  }

  void (async () => {
    const created = await createCompositor(clock)
    if (stopped) {
      // Teardown already ran while the compositor was still loading — dispose
      // it immediately rather than leaving a mounted, ticking instance behind
      // that nothing will ever tear down.
      created.dispose()
      return
    }

    compositor = created
    compositor.mount(canvas)
    sendHello(channel)
    frame = requestFrame(loop)
  })()

  return () => {
    stopped = true
    unsubscribeResize()
    unsubscribe()
    if (frame !== undefined) {
      cancelFrame(frame)
      frame = undefined
    }
    disposeOnce()
  }
}
