// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure logic for the validation probe's sentinel technique, split out into its own file
// specifically so it can be unit-tested: `probe.ts` imports `HydraCompositor` from
// `./compositor.ts`, which imports `hydra-synth` — a module that touches `window` at import time
// (see `index.ts`'s doc comment) and so cannot be imported under Node's `vitest` environment this
// package's tests run in. This file imports neither, so `sentinel.test.ts` can exercise it with
// plain synthetic `Uint8Array` data.

/**
 * The colour `probeClip` fills a slot with before running a clip. Not `0`, not `1`, not a round
 * number on any channel, and not equal on any two channels — chosen so nothing a clip does by
 * accident (a default clear, a rounded colour, a common test value) could produce it.
 */
export const SENTINEL_RGB = [0.37, 0.11, 0.83] as const

/** Hydra source that fills the whole buffer with `SENTINEL_RGB`, fully opaque — deliberately plain, since this must compile and run under the same `load()` path a clip does. */
export const SENTINEL_CODE = `solid(${SENTINEL_RGB[0]}, ${SENTINEL_RGB[1]}, ${SENTINEL_RGB[2]}, 1).out()`

/** How far a sampled byte may drift from the sentinel's exact expected value (0-255 scale) and still count as a match — covers ordinary float-to-byte rounding, not a real difference. */
const SENTINEL_TOLERANCE = 4

/** Two sampled channel values count as "different" once they're at least this far apart (0-255 scale). */
const CHANGE_THRESHOLD = 2

const expectedSentinelByte = (fraction: number): number => Math.round(fraction * 255)

/**
 * Whether `pixels` (a `HydraCompositor.readSlotPixels` read) is still the sentinel fill — checked
 * against every sampled pixel, not just the first, since a partially-drawn buffer is not a
 * confirmed fill either.
 *
 * `probeClip` calls this right after filling a slot with `SENTINEL_CODE` and ticking once, BEFORE
 * trusting anything that follows: if the fill did not actually take, everything after it is
 * meaningless — there would be no known-good reference to compare the clip's result against.
 */
export const isSentinelFill = (pixels: Uint8Array): boolean => {
  if (pixels.length === 0 || pixels.length % 4 !== 0) {
    return false
  }

  const expected = SENTINEL_RGB.map(expectedSentinelByte)

  for (let i = 0; i + 3 < pixels.length; i += 4) {
    for (const [channel, target] of expected.entries()) {
      if (Math.abs(pixels[i + channel] - target) > SENTINEL_TOLERANCE) {
        return false
      }
    }
  }

  return true
}

/**
 * Whether `after` differs from `before` by at least `CHANGE_THRESHOLD` on some channel, at some
 * sampled position. This is the actual black-frame decision (see `probeClip`): `before` is the
 * CONFIRMED sentinel fill of a clip's own buffer (`HydraCompositor.readSlotPixels`), sampled
 * before the clip has run at all; `after` is the same buffer sampled once the clip has been
 * loaded, switched in, and ticked. A clip that wrote anything to its own buffer — a bright
 * kaleidoscope, a flat white fill, a flat BLACK fill, a dark blue gradient, anything — overwrites
 * the sentinel and differs; a clip that rendered nothing to its own buffer leaves the sentinel
 * exactly as it was and fails. That is a clip whose chain produces no image at all: an `.out(`
 * call reached by nothing, a source that never initialises, a shader that clears and stops.
 *
 * It is NOT a clip that names another buffer. An earlier version of this comment offered
 * `.out(o3)` as the example, which `rewriteOut` (`rewrite.ts`) has since made impossible: a
 * clip's single `.out(...)` call, whatever it names, is rewritten to the slot's own buffer before
 * `load` ever sees it, and a clip with two or more is refused by `probeClip` before anything is
 * mounted. By the time `framesDiffer` is asked anything, the clip can only be writing its own
 * buffer or writing nothing.
 *
 * Sampling each slot's OWN buffer, not the composed canvas, is what makes this decidable at all.
 * An earlier version of this gate sampled the canvas instead, compared against a baseline taken
 * right after `mount()` — Hydra's idle clear colour, which is bit-identical to a deliberately
 * black clip, so a genuinely black clip and an unrendered canvas were indistinguishable there.
 * Worse: `composeIdle()` re-hooks the canvas to whichever slot's buffer is "current" and that
 * buffer's own default content can drift across ticks for reasons that have nothing to do with
 * whether the clip's code wrote anything — which let a clip that rendered nothing at all pass.
 * Comparing a slot's own buffer against a known, confirmed sentinel sidesteps both problems and
 * answers the actual question the gate exists to ask: did *this clip's code* put something in its
 * own buffer.
 */
export const framesDiffer = (before: Uint8Array, after: Uint8Array): boolean => {
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
