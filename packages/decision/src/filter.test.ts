// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CandidateClip, ClipEnergy, EngineKind } from '@vev/shared'
import { describe, expect, it } from 'vitest'

import { filterCandidates, MIN_CANDIDATES, RECENCY_WINDOW } from './filter.ts'

interface ClipOverrides {
  annotationStatus?: CandidateClip['annotationStatus']
  commercialOk?: boolean
  energy?: ClipEnergy
  engine?: EngineKind
  tags?: string[]
  usesFeedback?: boolean
}

const clip = (id: string, overrides: ClipOverrides = {}): CandidateClip => ({
  annotationStatus: 'ok',
  commercialOk: true,
  engine: 'hydra',
  id,
  usesFeedback: false,
  ...overrides,
})

const ids = (clips: readonly CandidateClip[]): string[] => clips.map((candidate) => candidate.id)

describe('candidate filtering', () => {
  it('never offers the clip that is already playing', () => {
    const clips = [clip('current'), clip('a'), clip('b'), clip('c')]
    const result = filterCandidates({ clips, commercial: false, currentClipId: 'current', historyIds: [] })
    expect(ids(result)).not.toContain('current')
  })

  it('drops clips whose licence is not cleared for commercial use, and only in commercial mode', () => {
    const clips = [clip('current'), clip('cleared'), clip('borrowed', { commercialOk: false }), clip('c')]

    const commercial = filterCandidates({
      clips,
      commercial: true,
      currentClipId: 'current',
      historyIds: [],
    })
    expect(ids(commercial)).toStrictEqual(['cleared', 'c'])

    const personal = filterCandidates({
      clips,
      commercial: false,
      currentClipId: 'current',
      historyIds: [],
    })
    expect(ids(personal)).toContain('borrowed')
  })

  it('keeps the last five clips out when enough candidates remain', () => {
    const historyIds = ['h1', 'h2', 'h3', 'h4', 'h5']
    const clips = [clip('current'), ...historyIds.map((id) => clip(id)), clip('a'), clip('b'), clip('c')]

    const result = filterCandidates({ clips, commercial: false, currentClipId: 'current', historyIds })

    expect(result.map((candidate) => candidate.id).toSorted()).toStrictEqual(['a', 'b', 'c'])
    expect(RECENCY_WINDOW).toBe(5)
  })

  it('lets recent clips back in rather than offer fewer than three', () => {
    const historyIds = ['h1', 'h2', 'h3', 'h4', 'h5']
    const clips = [clip('current'), ...historyIds.map((id) => clip(id)), clip('fresh')]

    const result = filterCandidates({ clips, commercial: false, currentClipId: 'current', historyIds })

    expect(result.length).toBeGreaterThanOrEqual(MIN_CANDIDATES)
    expect(ids(result)).toContain('h5')
  })

  it('keeps the hard exclusions even when recency is relaxed', () => {
    const historyIds = ['h1', 'h2', 'h3', 'h4', 'h5']
    const clips = [
      clip('current'),
      ...historyIds.map((id) => clip(id)),
      clip('borrowed', { commercialOk: false }),
      clip('fresh'),
    ]

    const result = filterCandidates({ clips, commercial: true, currentClipId: 'current', historyIds })

    expect(ids(result)).not.toContain('borrowed')
    expect(ids(result)).not.toContain('current')
  })

  it('applies a direction’s avoided tags as an exclusion', () => {
    const clips = [
      clip('current'),
      clip('strobe', { tags: ['strobe'] }),
      clip('calm', { tags: ['minimal'] }),
      clip('b'),
      clip('c'),
    ]
    const direction = {
      at: 0,
      avoidTags: ['strobe'],
      source: 'dictionary' as const,
      tags: ['minimal'],
      text: 'calm, no strobe',
    }

    const result = filterCandidates({
      clips,
      commercial: false,
      currentClipId: 'current',
      direction,
      historyIds: [],
    })

    expect(ids(result)).not.toContain('strobe')
    expect(ids(result)).toContain('calm')
  })

  it('applies a direction’s engine as an exclusion', () => {
    const clips = [
      clip('current'),
      clip('hydra', { engine: 'hydra' }),
      clip('tm', { engine: 'textmode' }),
      clip('tm2', { engine: 'textmode' }),
      clip('isf', { engine: 'isf' }),
    ]
    const direction = {
      at: 0,
      engine: 'textmode' as const,
      source: 'manual' as const,
      text: 'textmode please',
    }

    const result = filterCandidates({
      clips,
      commercial: false,
      currentClipId: 'current',
      direction,
      historyIds: [],
    })

    expect(ids(result).toSorted()).toStrictEqual(['tm', 'tm2'])
  })
})
