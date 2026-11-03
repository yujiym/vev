// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'

import type { SampledFrame } from './palette.ts'
import { dominantColours } from './palette.ts'

/** Builds an RGBA pixel buffer of `count` pixels, all the given colour. */
const solidPixels = (count: number, r: number, g: number, b: number): number[] => {
  const data: number[] = []
  for (let i = 0; i < count; i += 1) {
    data.push(r, g, b, 255)
  }
  return data
}

describe(dominantColours, () => {
  it('returns one colour for a uniform frame', () => {
    // (0, 192, 32) sits exactly on the bucketing grid, so the round trip is exact.
    const frame: SampledFrame = { data: solidPixels(64, 0, 192, 32) }

    const colours = dominantColours([frame])

    expect(colours).toStrictEqual(['#00c020'])
  })

  it('returns both colours for a frame that is half red and half blue', () => {
    const frame: SampledFrame = {
      data: [...solidPixels(32, 255, 0, 0), ...solidPixels(32, 0, 0, 255)],
    }

    const colours = dominantColours([frame])

    expect(colours).toHaveLength(2)
    expect(colours).toStrictEqual(expect.arrayContaining(['#ff0000', '#0000ff']))
  })

  it('ranks the more frequent colour first', () => {
    const frame: SampledFrame = {
      data: [...solidPixels(3, 255, 0, 0), ...solidPixels(30, 0, 255, 0)],
    }

    const colours = dominantColours([frame])

    expect(colours[0]).toBe('#00ff00')
  })

  it('caps the result at maxColours', () => {
    const frame: SampledFrame = {
      data: [
        ...solidPixels(1, 0, 0, 0),
        ...solidPixels(1, 255, 255, 255),
        ...solidPixels(1, 255, 0, 0),
        ...solidPixels(1, 0, 255, 0),
        ...solidPixels(1, 0, 0, 255),
      ],
    }

    const colours = dominantColours([frame], 2)

    expect(colours).toHaveLength(2)
  })
})
