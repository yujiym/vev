// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'

import { framesDiffer, isSentinelFill, SENTINEL_RGB } from './sentinel.ts'

const sentinelBytes = SENTINEL_RGB.map((fraction) => Math.round(fraction * 255))

/** Builds an RGBA pixel buffer of `count` pixels, all the given colour. */
const solidPixels = (count: number, r: number, g: number, b: number, a = 255): Uint8Array => {
  const data = new Uint8Array(count * 4)
  for (let i = 0; i < count; i += 1) {
    data.set([r, g, b, a], i * 4)
  }
  return data
}

describe(isSentinelFill, () => {
  it('is true for a buffer uniformly filled with the sentinel colour', () => {
    const [r, g, b] = sentinelBytes
    expect(isSentinelFill(solidPixels(16, r, g, b))).toBe(true)
  })

  it('is false for an unrelated uniform colour', () => {
    expect(isSentinelFill(solidPixels(16, 0, 0, 0))).toBe(false)
  })

  it('is false when only part of the buffer holds the sentinel — a partial fill is not a confirmed one', () => {
    const [r, g, b] = sentinelBytes
    const data = new Uint8Array([...solidPixels(8, r, g, b), ...solidPixels(8, 0, 0, 0)])
    expect(isSentinelFill(data)).toBe(false)
  })

  it('is false for an empty buffer', () => {
    expect(isSentinelFill(new Uint8Array(0))).toBe(false)
  })

  it('tolerates ordinary float-to-byte rounding drift', () => {
    const [r, g, b] = sentinelBytes
    expect(isSentinelFill(solidPixels(4, r + 1, g - 1, b + 1))).toBe(true)
  })
})

describe(framesDiffer, () => {
  it('reports no difference when the buffer still equals the sentinel — the actual black-frame case', () => {
    const [r, g, b] = sentinelBytes
    const sentinel = solidPixels(16, r, g, b)
    const after = solidPixels(16, r, g, b)
    expect(framesDiffer(sentinel, after)).toBe(false)
  })

  it('reports a difference for a clip that overwrote the sentinel with solid white', () => {
    const [r, g, b] = sentinelBytes
    const sentinel = solidPixels(16, r, g, b)
    const after = solidPixels(16, 255, 255, 255)
    expect(framesDiffer(sentinel, after)).toBe(true)
  })

  it('reports a difference for a clip that overwrote the sentinel with solid BLACK — a legitimate clip, not a failure', () => {
    const [r, g, b] = sentinelBytes
    const sentinel = solidPixels(16, r, g, b)
    const after = solidPixels(16, 0, 0, 0)
    expect(framesDiffer(sentinel, after)).toBe(true)
  })

  it('reports a difference for a rendered gradient against the sentinel', () => {
    const [r, g, b] = sentinelBytes
    const sentinel = solidPixels(4, r, g, b)
    const after = new Uint8Array([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255, 100, 110, 120, 255])
    expect(framesDiffer(sentinel, after)).toBe(true)
  })

  it('ignores changes smaller than the threshold — sensor noise is not a render', () => {
    const [r, g, b] = sentinelBytes
    const sentinel = solidPixels(4, r, g, b)
    const after = solidPixels(4, r + 1, g, b - 1)
    expect(framesDiffer(sentinel, after)).toBe(false)
  })
})
