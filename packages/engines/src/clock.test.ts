// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'

import { barDurationMs, barPhase, bpmFromTaps, nextBarAt } from './clock.ts'

describe('bar timing', () => {
  it('is four beats long at the given tempo', () => {
    expect(barDurationMs(120)).toBe(2000)
    expect(barDurationMs(140)).toBeCloseTo(1714.2857, 3)
  })

  it('reports where in the bar a moment falls', () => {
    const clock = { beatsPerBar: 4, bpm: 120, downbeatAt: 1000 }
    expect(barPhase(clock, 1000)).toBe(0)
    expect(barPhase(clock, 2000)).toBe(0.5)
    expect(barPhase(clock, 3000)).toBe(0)
    expect(barPhase(clock, 500)).toBe(0.75)
  })

  it('finds the next downbeat, and never returns the current moment when it is already one', () => {
    const clock = { beatsPerBar: 4, bpm: 120, downbeatAt: 1000 }
    expect(nextBarAt(clock, 1500)).toBe(3000)
    expect(nextBarAt(clock, 3000)).toBe(5000)
  })

  it('reads a tempo from taps, and refuses fewer than two', () => {
    expect(bpmFromTaps([0, 500, 1000, 1500])).toBeCloseTo(120, 6)
    expect(bpmFromTaps([1000])).toBeUndefined()
    expect(bpmFromTaps([])).toBeUndefined()
  })
})
