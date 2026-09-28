// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure pixel-comparison logic for the validation probe (`probe.ts`), split out into its own file
// specifically so it can be unit-tested: `probe.ts` imports `HydraCompositor` from
// `./compositor.ts`, which imports `hydra-synth` — a module that touches `window` at import time
// (see `index.ts`'s doc comment) and so cannot be imported under Node's `vitest` environment this
// package's tests run in. This file imports neither, so `frame-diff.test.ts` can exercise it with
// plain synthetic `Uint8ClampedArray` data.

/**
 * Two sampled channel values count as "different" once they're at least this far apart (0-255
 * scale). Deliberately low — the point is to catch any real change against the pre-render
 * baseline, not to demand a dramatic one.
 */
const CHANGE_THRESHOLD = 2

/**
 * Whether `after` differs from `before` by at least `CHANGE_THRESHOLD` on some channel, at some
 * sampled position. This is the actual black-frame decision (see `probeClip` in `probe.ts`):
 * `before` is a baseline sampled right after `mount()`, before the clip has run at all; `after` is
 * sampled once the clip has been loaded, switched in, and ticked. A clip that changed the buffer —
 * a bright kaleidoscope, a flat white fill, a dark blue gradient, anything — differs from the
 * baseline and passes; a clip that rendered nothing leaves the buffer exactly as `mount()` left it
 * and fails.
 *
 * This is deliberately a *comparison*, not a measurement of `after` alone. An earlier version of
 * this gate checked spatial variance within a single frame instead (see `hasFrameVariance` below)
 * and rejected `solid(1,1,1,1).out()` — a legitimate, uniformly-white clip — because a uniform
 * rendered frame and a uniform unrendered one are indistinguishable by variance alone. Comparing
 * against a pre-render baseline decides both cases correctly and needs no assumption about what
 * Hydra's clear colour happens to be.
 */
export const framesDiffer = (before: Uint8ClampedArray, after: Uint8ClampedArray): boolean => {
  if (before.length !== after.length) {
    return true
  }

  for (const [i, beforeValue] of before.entries()) {
    if (Math.abs(after[i] - beforeValue) >= CHANGE_THRESHOLD) {
      return true
    }
  }

  return false
}

/**
 * Whether sampled RGBA pixels show spatial variation within themselves, as opposed to being one
 * uniform colour. Exported as a secondary signal (a caller may want to distinguish "a busy clip"
 * from "a flat one" for other purposes) — **not** used by `probeClip` to decide pass/fail anymore.
 * It used to be: a variance-only check cannot tell a legitimately uniform rendered frame
 * (`solid(1,1,1,1).out()`) apart from a genuinely unrendered one, since both have zero variance.
 * See `framesDiffer`, which replaced it as the actual black-frame decision.
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

  return maxR - minR >= CHANGE_THRESHOLD || maxG - minG >= CHANGE_THRESHOLD || maxB - minB >= CHANGE_THRESHOLD
}
