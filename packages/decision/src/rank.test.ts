// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CandidateClip, ClipEnergy, Direction, EngineKind } from '@vev/shared'
import { describe, expect, it } from 'vitest'

import { NEUTRAL_ENERGY, rankByRules } from './rank.ts'

interface ClipOverrides {
  energy?: ClipEnergy
  engine?: EngineKind
  tags?: string[]
}

const clip = (id: string, overrides: ClipOverrides = {}): CandidateClip => ({
  annotationStatus: 'ok',
  commercialOk: true,
  engine: 'hydra',
  id,
  usesFeedback: false,
  ...overrides,
})

const direction = (overrides: Partial<Direction> = {}): Direction => ({
  at: 0,
  source: 'dictionary',
  text: 'steer',
  ...overrides,
})

const order = (clips: readonly CandidateClip[], input = {}): string[] =>
  rankByRules(clips, { historyIds: [], ...input }).map((candidate) => candidate.clip.id)

describe('rule ranking', () => {
  it('puts a clip carrying the direction’s tags first', () => {
    const clips = [clip('plain', { tags: ['noise'] }), clip('text', { tags: ['text', 'glitch'] })]
    expect(order(clips, { direction: direction({ tags: ['text'] }) })[0]).toBe('text')
  })

  it('ranks by closeness to the wanted energy', () => {
    const clips = [clip('calm', { energy: 1 }), clip('peak', { energy: 5 }), clip('middle', { energy: 3 })]
    expect(order(clips, { energyTarget: 5 })[0]).toBe('peak')
    expect(order(clips, { energyTarget: 1 })[0]).toBe('calm')
  })

  it('treats the direction’s energy target as the wanted energy when no explicit target is given', () => {
    const clips = [clip('calm', { energy: 1 }), clip('peak', { energy: 5 })]
    expect(order(clips, { direction: direction({ energyTarget: 1 }) })[0]).toBe('calm')
  })

  it('uses the section’s energy when neither an explicit target nor a direction names one', () => {
    const clips = [clip('calm', { energy: 2 }), clip('peak', { energy: 5 })]
    expect(order(clips, { section: 'break' })[0]).toBe('calm')
  })

  it('still ranks a clip annotation has not reached', () => {
    const clips = [clip('unannotated')]
    const [ranked] = rankByRules(clips, { historyIds: [] })

    expect(ranked?.clip.id).toBe('unannotated')
    expect(ranked?.score).toBeGreaterThan(0)
    expect(ranked?.score).toBeLessThanOrEqual(1)
    expect(ranked?.reason).toContain('unannotated')
    expect(NEUTRAL_ENERGY).toBe(3)
  })

  it('keeps every candidate, including ones the direction’s tags do not match', () => {
    const clips = [clip('text', { tags: ['text'] }), clip('plain', { tags: ['noise'] })]
    const ranked = rankByRules(clips, { direction: direction({ tags: ['text'] }), historyIds: [] })
    expect(ranked).toHaveLength(2)
  })

  it('places a clip that has already played below one of the same energy that has not', () => {
    const clips = [clip('played', { energy: 3 }), clip('fresh', { energy: 3 })]
    expect(order(clips, { historyIds: ['played'] })[0]).toBe('fresh')
  })

  it('breaks a tie by clip id so the same question always gets the same order', () => {
    const clips = [clip('b', { energy: 3 }), clip('a', { energy: 3 })]
    expect(order(clips)).toStrictEqual(['a', 'b'])
    expect(order(clips)).toStrictEqual(order(clips.toReversed()))
  })

  it('marks every result as a rule fallback, never as a decision', () => {
    const ranked = rankByRules([clip('a')], { historyIds: [] })
    expect(ranked.map((candidate) => candidate.source)).toStrictEqual(['fallback'])
  })

  it('writes a short reason naming the signals that produced the score', () => {
    const clips = [clip('text', { energy: 4, tags: ['text'] })]
    const [ranked] = rankByRules(clips, {
      direction: direction({ tags: ['text'] }),
      energyTarget: 4,
      historyIds: [],
    })

    expect(ranked?.reason).toBe('tag text; energy 4→4; unplayed')
  })
})
