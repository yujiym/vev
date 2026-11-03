// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'

import { STILL_COUNT, stillMoments, stillSize } from './stills.ts'

/** TypeSafe's published image limits, restated so the test can check the sizes against the source of truth rather than against `stills.ts`. */
const LIMITS = { maxPixels: 2_458_624, maxSide: 1568, minPixels: 78_400, minSide: 280 }

const withinLimits = (size: { height: number; width: number }): boolean =>
  Math.min(size.width, size.height) >= LIMITS.minSide &&
  Math.max(size.width, size.height) <= LIMITS.maxSide &&
  size.width * size.height >= LIMITS.minPixels &&
  size.width * size.height <= LIMITS.maxPixels

describe(stillSize, () => {
  it('enlarges the 320x180 registration canvas, which is below the 280-pixel side minimum as drawn', () => {
    expect(stillSize(320, 180)).toStrictEqual({ height: 288, width: 512 })
  })

  it('shrinks a large canvas to a 512-pixel long side', () => {
    expect(stillSize(1920, 1080)).toStrictEqual({ height: 288, width: 512 })
  })

  it('keeps a portrait canvas portrait', () => {
    expect(stillSize(180, 320)).toStrictEqual({ height: 512, width: 288 })
  })

  it.each([
    [320, 180],
    [1920, 1080],
    [640, 640],
    [1000, 300],
    [301, 281],
  ])('returns a size inside every limit for a %ix%i canvas', (width, height) => {
    const size = stillSize(width, height)
    expect(size !== undefined && withinLimits(size)).toBe(true)
  })

  it('returns nothing for a canvas that has no area', () => {
    expect(stillSize(0, 180)).toBeUndefined()
    expect(stillSize(320, 0)).toBeUndefined()
  })

  it('returns nothing for a strip too elongated for any size to meet the limits', () => {
    expect(stillSize(4000, 100)).toBeUndefined()
  })
})

describe(stillMoments, () => {
  it('spreads the stills across the recording, clear of both ends', () => {
    expect(stillMoments(3000)).toStrictEqual([500, 1500, 2500])
  })

  it('takes as many stills as a clip is given', () => {
    expect(stillMoments(3000)).toHaveLength(STILL_COUNT)
  })
})
