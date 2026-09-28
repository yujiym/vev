// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Clock } from '../clock.ts'
import { HydraCompositor } from './compositor.ts'

/** How many ticks the probe advances before sampling — enough for a `.out()` chain to settle past its first (often still-clearing) frame. */
const PROBE_FRAMES = 6

/** Milliseconds of wall-clock advanced per probed tick — a nominal 30fps, independent of the caller's real frame rate. */
const PROBE_TICK_MS = 1000 / 30

/**
 * A frame is judged rendered, not merely cleared, once its sampled pixels vary by at least this
 * much (0-255 scale) across a channel. Deliberately low: the point is to tell a genuinely
 * unrendered canvas (uniformly the WebGL clear colour) apart from real — possibly very dark —
 * content, not to demand visual busyness. See the module doc below for why this is a variance
 * check and not a magnitude check.
 */
const VARIANCE_THRESHOLD = 2

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

/**
 * Whether sampled RGBA pixels show real spatial variation, as opposed to a uniform buffer.
 *
 * This checks *variance*, not magnitude — a frame is judged rendered once its pixels differ from
 * one another by `VARIANCE_THRESHOLD` or more on some channel, regardless of how dark or bright
 * those pixels are. A magnitude check ("are pixels non-zero") would reject every dark clip,
 * including M1's `quiet` fixture — a slow, low-brightness gradient that is nonetheless genuinely
 * rendering. A truly unrendered canvas (still at WebGL's clear colour) is uniform and has zero
 * variance regardless of what that clear colour is; real content, however dark, is not uniform.
 *
 * The accepted trade-off: a clip that deliberately renders one flat, unvarying colour across the
 * whole frame reads the same as an unrendered one and is rejected too. Spec §11.2 asks for "not a
 * black frame", not "not a flat frame" — this is the closest a pixel-only check can get without
 * false-rejecting legitimate dark clips, which is the failure mode named in the M2 brief.
 */
export const hasFrameVariance = (pixels: Uint8ClampedArray): boolean => {
  let minR = 255
  let maxR = 0
  let minG = 255
  let maxG = 0
  let minB = 255
  let maxB = 0

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    const r = pixels[i]
    const g = pixels[i + 1]
    const b = pixels[i + 2]
    if (r < minR) {
      minR = r
    }
    if (r > maxR) {
      maxR = r
    }
    if (g < minG) {
      minG = g
    }
    if (g > maxG) {
      maxG = g
    }
    if (b < minB) {
      minB = b
    }
    if (b > maxB) {
      maxB = b
    }
  }

  return (
    maxR - minR >= VARIANCE_THRESHOLD ||
    maxG - minG >= VARIANCE_THRESHOLD ||
    maxB - minB >= VARIANCE_THRESHOLD
  )
}

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
 */
export const probeClip = async (code: string, canvas: HTMLCanvasElement): Promise<ProbeResult> => {
  const clock: Clock = { beatsPerBar: 4, bpm: 120, downbeatAt: Date.now() }
  const compositor = new HydraCompositor(clock)

  try {
    compositor.mount(canvas)
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

  let maxFrameMs = 0
  try {
    let now = Date.now()
    for (let i = 0; i < PROBE_FRAMES; i += 1) {
      const start = performance.now()
      compositor.tick(now)
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

  let pixels: Uint8ClampedArray
  try {
    pixels = await sampleCanvas(canvas)
  } catch (error) {
    compositor.dispose()
    return { error, ok: false, reason: 'render-error' }
  }

  compositor.dispose()

  if (!hasFrameVariance(pixels)) {
    return { maxFrameMs, ok: false, reason: 'black-frame' }
  }

  return { maxFrameMs, ok: true }
}
