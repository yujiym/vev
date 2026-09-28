// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Slot } from '@vev/shared'

import type { Clock } from '../clock.ts'
import { HydraCompositor } from './compositor.ts'
import { countOutCalls, MULTI_OUTPUT_MESSAGE } from './rewrite.ts'
import { framesDiffer, isSentinelFill, SENTINEL_CODE } from './sentinel.ts'

/** The slot the probe always runs a clip in — matches the show's slot `a` (spec §6.1). */
const PROBE_SLOT: Slot = 'a'

/** How many ticks the probe advances the real clip before sampling — enough for a `.out()` chain to settle past its first (often still-clearing) frame. */
const PROBE_FRAMES = 6

/** Milliseconds of wall-clock advanced per probed tick — a nominal 30fps, independent of the caller's real frame rate. */
const PROBE_TICK_MS = 1000 / 30

/**
 * A single probed tick may not take longer than this to run, or the clip is judged unfit for the
 * show's frame budget. No number for this appears in spec §11.2 ("holds its frame budget"); 50ms
 * is chosen as roughly 3 missed frames at 60fps — clearly pathological, while staying well clear
 * of ordinary jitter on a loaded machine.
 */
const FRAME_BUDGET_MS = 50

/** Why a probe did not pass — a clip failing one of spec §11.2's checks is an expected outcome, not an exception (see `probeClip`'s doc comment). */
export type ProbeFailureReason =
  | 'black-frame'
  | 'budget-exceeded'
  | 'compile-error'
  | 'multi-output'
  | 'render-error'

export type ProbeResult =
  | { readonly maxFrameMs: number; readonly ok: true }
  | {
      readonly error?: unknown
      readonly maxFrameMs?: number
      // Set only where the reason is something the author can act on by editing the clip in a
      // specific way, as opposed to a diagnosis (`black-frame`, `budget-exceeded`) — currently
      // just `multi-output`. Callers that show a failure should prefer this over the bare
      // `reason` when it's present.
      readonly message?: string
      readonly ok: false
      readonly reason: ProbeFailureReason
    }

/**
 * Runs a clip through the ordinary render path and reports whether it clears spec §11.2's gate:
 * writes exactly one buffer, compiles, renders without errors, is not a black frame, holds its
 * frame budget.
 *
 * Deliberately reuses `HydraCompositor.load` / `switchTo` exactly as the show does — `load('a',
 * code)` then `switchTo('a', { kind: 'cut', bars: 0 }, now)` — rather than a probe-specific
 * rendering path. A probe with its own path can pass a clip the real show fails to render, which
 * is the one thing a validation gate must never do (see the M2 task 4 brief).
 *
 * Returns a structured `ProbeResult` rather than throwing: a clip that fails to render is an
 * expected outcome of registration, not an exceptional one. `canvas` is the caller's — mounting,
 * probing and disposing all happen against it here; the caller owns creating and discarding that
 * canvas (see the registration page, which disposes the compositor immediately after use, per
 * spec §6.5's cap on live WebGL contexts).
 *
 * **The multi-output check runs before anything is mounted, because it needs nothing GL-backed to
 * answer.** A clip has exactly one buffer of its own (spec §6.1: the compositor owns
 * `o0`/`o1`/`o2`/`o3`); `rewriteOut` (`rewrite.ts`) rewrites a clip's single `.out(...)` call —
 * bare or named — to that buffer regardless of what it named, so this check only has to rule out
 * the case `rewriteOut` itself refuses to guess at: two or more `.out(` calls, where there is no
 * way to tell which one the clip's author meant. Refusing here, before `rewriteOut` ever runs,
 * means a multi-output clip never gets a buffer it does not own written to it, not even once.
 *
 * **The black-frame check is a sentinel, not a baseline comparison.** Before the clip ever runs,
 * the probe fills the slot's own buffer with `SENTINEL_CODE` — a colour no clip produces by
 * accident — ticks once, and confirms with `isSentinelFill` that the fill actually took (a
 * failed confirmation is a `render-error`, not a black frame: nothing about the clip has been
 * tested yet). Only then does it load and run the real clip and sample the same buffer again
 * (`HydraCompositor.readSlotPixels`, not the canvas) via `framesDiffer`: if the buffer still
 * equals the sentinel, the clip wrote nothing to it and the probe fails; any other result —
 * including a legitimate solid black or solid white clip — passes. See `sentinel.ts` for why an
 * earlier baseline-comparison version of this check was wrong (it could both reject a legitimate
 * uniform clip and accept a clip that rendered nothing).
 *
 * **The frame-budget loop forces a real GPU sync.** `compositor.tick()` only queues regl draw
 * calls — a GPU driver is free to accept a queued command near-instantly and do the actual work
 * later, so timing `tick()` alone measures submission cost, not render cost, and could never
 * catch an expensive clip. `readSlotPixels` cannot return a correct result until every draw call
 * that could affect the read region has actually finished, so calling it once per tick (its
 * result otherwise unused here) is exactly the synchronisation point the budget check needs.
 */
const runProbe = (code: string, canvas: HTMLCanvasElement): ProbeResult => {
  if (countOutCalls(code) > 1) {
    return { message: MULTI_OUTPUT_MESSAGE, ok: false, reason: 'multi-output' }
  }

  const clock: Clock = { beatsPerBar: 4, bpm: 120, downbeatAt: Date.now() }
  const compositor = new HydraCompositor(clock)

  let sentinel: Uint8Array
  try {
    compositor.mount(canvas)
    compositor.load(PROBE_SLOT, SENTINEL_CODE)
    compositor.tick(Date.now())
    sentinel = compositor.readSlotPixels(PROBE_SLOT)
  } catch (error) {
    compositor.dispose()
    return { error, ok: false, reason: 'render-error' }
  }

  if (!isSentinelFill(sentinel)) {
    compositor.dispose()
    return { ok: false, reason: 'render-error' }
  }

  try {
    compositor.load(PROBE_SLOT, code)
  } catch (error) {
    compositor.dispose()
    return { error, ok: false, reason: 'compile-error' }
  }

  try {
    compositor.switchTo(PROBE_SLOT, { bars: 0, kind: 'cut' }, Date.now())
  } catch (error) {
    compositor.dispose()
    return { error, ok: false, reason: 'render-error' }
  }

  let maxFrameMs = 0
  try {
    let now = Date.now()
    for (let i = 0; i < PROBE_FRAMES; i += 1) {
      const start = performance.now()
      compositor.tick(now)
      compositor.readSlotPixels(PROBE_SLOT)
      const frameMs = performance.now() - start
      if (frameMs > maxFrameMs) {
        maxFrameMs = frameMs
      }
      now += PROBE_TICK_MS
    }
  } catch (error) {
    compositor.dispose()
    return { error, ok: false, reason: 'render-error' }
  }

  if (maxFrameMs > FRAME_BUDGET_MS) {
    compositor.dispose()
    return { maxFrameMs, ok: false, reason: 'budget-exceeded' }
  }

  let after: Uint8Array
  try {
    after = compositor.readSlotPixels(PROBE_SLOT)
  } catch (error) {
    compositor.dispose()
    return { error, ok: false, reason: 'render-error' }
  }

  compositor.dispose()

  if (!framesDiffer(sentinel, after)) {
    return { maxFrameMs, ok: false, reason: 'black-frame' }
  }

  return { maxFrameMs, ok: true }
}

/**
 * Thin `Promise` wrapper around `runProbe`. Everything `runProbe` does — mounting, loading,
 * ticking, and reading pixels back via `HydraCompositor.readSlotPixels` (a real, synchronous GPU
 * sync, see its doc comment) — is synchronous; `probeClip` stays `Promise`-returning because that
 * is its documented public contract (a probe caller should not need to know that this particular
 * implementation happens not to await anything).
 */
export const probeClip = async (code: string, canvas: HTMLCanvasElement): Promise<ProbeResult> =>
  await Promise.resolve(runProbe(code, canvas))
