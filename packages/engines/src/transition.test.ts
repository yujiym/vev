// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'

import type { Clock } from './clock.ts'
import { fadeProgress } from './transition.ts'

const clock: Clock = { beatsPerBar: 4, bpm: 120, downbeatAt: 0 }

describe(fadeProgress, () => {
  it('runs from 0 to 1 across the transition length', () => {
    const fade = { bars: 2, kind: 'crossfade' } as const
    expect(fadeProgress(fade, 1000, 1000, clock)).toBe(0)
    expect(fadeProgress(fade, 1000, 3000, clock)).toBe(0.5)
    expect(fadeProgress(fade, 1000, 5000, clock)).toBe(1)
  })

  it('clamps outside its window rather than overshooting', () => {
    const fade = { bars: 1, kind: 'crossfade' } as const
    expect(fadeProgress(fade, 1000, 0, clock)).toBe(0)
    expect(fadeProgress(fade, 1000, 99_999, clock)).toBe(1)
  })

  it('is already finished for a cut, which has no duration', () => {
    expect(fadeProgress({ bars: 0, kind: 'cut' }, 1000, 1000, clock)).toBe(1)
  })
})
