// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ClipEnergy, EngineKind, TransitionKind, TransitionSpec } from '@vev/shared'
import { describe, expect, it } from 'vitest'

import { chooseTransition, withVariety } from './transition.ts'

const DEFAULT: TransitionSpec = { bars: 2, kind: 'crossfade' }

interface SwitchOverrides {
  currentEnergy?: ClipEnergy
  currentEngine?: EngineKind
  defaultTransition?: TransitionSpec
  explicit?: TransitionSpec
  locked?: TransitionSpec
  nextEnergy?: ClipEnergy
  nextEngine?: EngineKind
  nextSection?: string
  recent?: TransitionKind[]
  usesFeedback?: boolean
}

const choose = (overrides: SwitchOverrides = {}): TransitionSpec =>
  chooseTransition({
    current: {
      energy: 'currentEnergy' in overrides ? overrides.currentEnergy : 3,
      engine: overrides.currentEngine ?? 'hydra',
    },
    defaultTransition: overrides.defaultTransition ?? DEFAULT,
    explicit: overrides.explicit,
    locked: overrides.locked,
    next: {
      energy: 'nextEnergy' in overrides ? overrides.nextEnergy : 3,
      engine: overrides.nextEngine ?? 'hydra',
      usesFeedback: overrides.usesFeedback ?? false,
    },
    nextSection: overrides.nextSection,
    recent: overrides.recent,
  })

describe('automatic transition choice', () => {
  it('cuts into a peak section', () => {
    expect(choose({ nextSection: 'peak' })).toStrictEqual({ bars: 0, kind: 'cut' })
  })

  it('crossfades over four bars into a break', () => {
    expect(choose({ nextSection: 'break' })).toStrictEqual({ bars: 4, kind: 'crossfade' })
  })

  it('cuts when the energy rises by two or more', () => {
    expect(choose({ currentEnergy: 2, nextEnergy: 4 })).toStrictEqual({ bars: 0, kind: 'cut' })
  })

  it('crossfades over four bars when the energy falls by two or more', () => {
    expect(choose({ currentEnergy: 4, nextEnergy: 2 })).toStrictEqual({ bars: 4, kind: 'crossfade' })
  })

  it('cuts into a clip that uses feedback', () => {
    expect(choose({ nextEnergy: 4, usesFeedback: true })).toStrictEqual({ bars: 0, kind: 'cut' })
  })

  it('crossfades over two bars across an engine change', () => {
    expect(choose({ currentEngine: 'hydra', nextEngine: 'textmode' })).toStrictEqual({
      bars: 2,
      kind: 'crossfade',
    })
  })

  it('crossfades over one bar when the engine stays and energy moves by at most one', () => {
    expect(choose({ currentEnergy: 3, nextEnergy: 4 })).toStrictEqual({ bars: 1, kind: 'crossfade' })
    expect(choose({ currentEnergy: 3, nextEnergy: 2 })).toStrictEqual({ bars: 1, kind: 'crossfade' })
  })

  it('falls back to the track default when no rule decides', () => {
    const defaultTransition: TransitionSpec = { bars: 8, kind: 'crossfade' }
    expect(choose({ currentEnergy: undefined, defaultTransition, nextEnergy: undefined })).toStrictEqual(
      defaultTransition,
    )
  })

  it('honours the performer’s explicit choice over every rule', () => {
    const explicit: TransitionSpec = { bars: 1, kind: 'cut' }
    expect(choose({ explicit, nextSection: 'break' })).toStrictEqual(explicit)
  })

  it('honours a locked transition over the rules', () => {
    const locked: TransitionSpec = { bars: 4, kind: 'crossfade' }
    expect(choose({ locked, nextSection: 'peak' })).toStrictEqual(locked)
  })

  it('prefers a different transition after three identical ones in a row', () => {
    const result = choose({ nextSection: 'peak', recent: ['cut', 'cut', 'cut'] })
    expect(result).toStrictEqual({ bars: 2, kind: 'crossfade' })
  })

  it('breaks a run of crossfades with a cut', () => {
    const result = choose({ recent: ['crossfade', 'crossfade', 'crossfade'] })
    expect(result).toStrictEqual({ bars: 0, kind: 'cut' })
  })

  it('does not override a human’s choice to keep a sequence interesting', () => {
    const explicit: TransitionSpec = { bars: 1, kind: 'cut' }
    expect(choose({ explicit, recent: ['cut', 'cut', 'cut'] })).toStrictEqual(explicit)
  })
})

describe(withVariety, () => {
  it('swaps a transition that would be the fourth identical one in a row', () => {
    expect(
      withVariety({ bars: 2, kind: 'crossfade' }, ['crossfade', 'crossfade', 'crossfade']),
    ).toStrictEqual({
      bars: 0,
      kind: 'cut',
    })
    expect(withVariety({ bars: 0, kind: 'cut' }, ['cut', 'cut', 'cut'])).toStrictEqual({
      bars: 2,
      kind: 'crossfade',
    })
  })

  it('leaves a transition alone when the last three were not all its kind', () => {
    const chosen: TransitionSpec = { bars: 2, kind: 'crossfade' }
    expect(withVariety(chosen, ['cut', 'crossfade', 'crossfade'])).toBe(chosen)
    expect(withVariety(chosen, ['crossfade', 'crossfade'])).toBe(chosen)
  })

  it('reads only the last three', () => {
    const chosen: TransitionSpec = { bars: 2, kind: 'crossfade' }
    expect(withVariety(chosen, ['cut', 'cut', 'cut', 'crossfade', 'cut', 'crossfade'])).toBe(chosen)
  })
})
