// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Clock } from '../clock.ts'
import { HydraCompositor } from './compositor.ts'
import { framesDiffer } from './frame-diff.ts'

/** How many ticks the probe advances before sampling — enough for a `.out()` chain to settle past its first (often still-clearing) frame. */
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
export type ProbeFailureReason = 'black-frame' | 'budget-exceeded' | 'compile-error' | 'render-error'

export type ProbeResult =
  | { readonly maxFrameMs: number; readonly ok: true }
  | {
      readonly error?: unknown
      readonly maxFrameMs?: number
      readonly ok: false
      readonly reason: ProbeFailureReason
    }

const sampleCanvas = async (canvas: HTMLCanvasElement): Promise<Uint8ClampedArray> => {
  const bitmap = await createImageBitmap(canvas)
  try {
    const offscreen = new OffscreenCanvas(bitmap.width, bitmap.height)
    const ctx = offscreen.getContext('2d')
    if (!ctx) {
      throw new Error('probeClip: could not obtain a 2d context to sample the canvas.')
    }
    ctx.drawImage(bitmap, 0, 0)
    return ctx.getImageData(0, 0, bitmap.width, bitmap.height).data
  } finally {
    bitmap.close()
  }
}

/** The WebGL context regl/Hydra already created on `canvas`, however it was requested. `getContext` with a matching type returns the SAME context, not a new one. */
const existingGlContext = (
  canvas: HTMLCanvasElement,
): WebGL2RenderingContext | WebGLRenderingContext | null =>
  canvas.getContext('webgl2') ?? canvas.getContext('webgl')

/**
 * Runs a clip through the ordinary render path and reports whether it clears spec §11.2's gate:
 * compiles, renders without errors, is not a black frame, holds its frame budget.
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
 * The black-frame check (`framesDiffer`, `frame-diff.ts`) samples the canvas right after `mount()`
 * as a baseline, before the clip has run at all, then again after loading, switching in, and
 * ticking it — and fails only if the two samples are identical. See that module for why this
 * replaced an earlier variance-only check that rejected legitimately uniform clips.
 *
 * The frame-budget loop forces a real GPU sync (`gl.readPixels` of a single pixel) after every
 * tick. `compositor.tick()` only queues regl draw calls — a GPU driver is free to accept a queued
 * command near-instantly and do the actual work later, so timing `tick()` alone measures
 * submission cost, not render cost, and can never catch an expensive clip. `readPixels` cannot
 * return a correct result until every draw call that could affect the read region has actually
 * finished, which is exactly the synchronisation point the budget check needs.
 */
export const probeClip = async (code: string, canvas: HTMLCanvasElement): Promise<ProbeResult> => {
  const clock: Clock = { beatsPerBar: 4, bpm: 120, downbeatAt: Date.now() }
  const compositor = new HydraCompositor(clock)

  let baseline: Uint8ClampedArray
  try {
    compositor.mount(canvas)
    baseline = await sampleCanvas(canvas)
  } catch (error) {
    compositor.dispose()
    return { error, ok: false, reason: 'render-error' }
  }

  try {
    compositor.load('a', code)
  } catch (error) {
    compositor.dispose()
    return { error, ok: false, reason: 'compile-error' }
  }

  try {
    compositor.switchTo('a', { bars: 0, kind: 'cut' }, Date.now())
  } catch (error) {
    compositor.dispose()
    return { error, ok: false, reason: 'render-error' }
  }

  const gl = existingGlContext(canvas)
  const syncPixel = new Uint8Array(4)

  let maxFrameMs = 0
  try {
    let now = Date.now()
    for (let i = 0; i < PROBE_FRAMES; i += 1) {
      const start = performance.now()
      compositor.tick(now)
      if (gl) {
        gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncPixel)
      }
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

  let after: Uint8ClampedArray
  try {
    after = await sampleCanvas(canvas)
  } catch (error) {
    compositor.dispose()
    return { error, ok: false, reason: 'render-error' }
  }

  compositor.dispose()

  if (!framesDiffer(baseline, after)) {
    return { maxFrameMs, ok: false, reason: 'black-frame' }
  }

  return { maxFrameMs, ok: true }
}
