// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'

import { framesDiffer, hasFrameVariance } from './frame-diff.ts'

/** Builds an RGBA pixel buffer of `count` pixels, all the given colour. */
const solidPixels = (count: number, r: number, g: number, b: number, a = 255): Uint8ClampedArray => {
  const data = new Uint8ClampedArray(count * 4)
  for (let i = 0; i < count; i += 1) {
    data.set([r, g, b, a], i * 4)
  }
  return data
}

describe(framesDiffer, () => {
  it('reports no difference for an identical, unchanged buffer — the actual black-frame case', () => {
    const before = solidPixels(16, 0, 0, 0)
    const after = solidPixels(16, 0, 0, 0)
    expect(framesDiffer(before, after)).toBe(false)
  })

  it('reports a difference for a uniform-but-rendered frame — solid(1,1,1,1) against a black baseline', () => {
    const before = solidPixels(16, 0, 0, 0)
    const after = solidPixels(16, 255, 255, 255)
    expect(framesDiffer(before, after)).toBe(true)
  })

  it('still reports a difference for a rendered gradient against a black baseline', () => {
    const before = solidPixels(4, 0, 0, 0)
    const after = new Uint8ClampedArray([
      10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255,
    ])
    expect(framesDiffer(before, after)).toBe(true)
  })

  it('ignores changes smaller than the threshold — sensor noise is not a render', () => {
    const before = solidPixels(4, 10, 10, 10)
    const after = solidPixels(4, 11, 11, 11)
    expect(framesDiffer(before, after)).toBe(false)
  })
})

describe(hasFrameVariance, () => {
  it('is false for a uniform frame', () => {
    expect(hasFrameVariance(solidPixels(9, 40, 40, 40))).toBe(false)
  })

  it('is true for a frame with spatial variation', () => {
    const data = new Uint8ClampedArray([0, 0, 0, 255, 200, 0, 0, 255])
    expect(hasFrameVariance(data)).toBe(true)
  })
})
