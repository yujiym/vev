// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CandidateClip, Direction } from '@vev/shared'

/**
 * How many of the most recent clips are kept out of the candidates (spec §8.1 step 1's "last N
 * clips"). Spec §8.2's history is the last five, so that is the window: the set that repeats is
 * exactly the set the performer just watched.
 */
export const RECENCY_WINDOW = 5

/**
 * The fewest candidates worth offering. Below three a screen that shows three has to pad or go
 * blank, so the recency rule is the one filter that yields under pressure — see below.
 */
export const MIN_CANDIDATES = 3

export interface FilterInput {
  /** True when the track is commercial; clips not cleared for commercial use then disappear (§14.2). */
  readonly commercial: boolean
  readonly currentClipId: string
  /** The standing direction, when there is one. Its `avoidTags` and `engine` are filters, not weights. */
  readonly direction?: Direction
  /** Most recent last. */
  readonly historyIds: readonly string[]
  readonly clips: readonly CandidateClip[]
}

/**
 * Spec §8.1 step 1: the clips that may be offered at all.
 *
 * Two classes of exclusion live here, and they are not equal. The current clip, a forbidden tag, a
 * required engine and the commercial filter are rules the caller asked for, and dropping one would
 * offer a clip the track or the direction has already ruled out. Recency is different: it is a
 * preference for variety, and an over-applied preference empties the screen, which is the one
 * outcome the show cannot survive (§0 principle 2). So when the recent window would leave fewer
 * than `MIN_CANDIDATES`, the recent clips come back and the hard exclusions stay.
 */
export const filterCandidates = (input: FilterInput): CandidateClip[] => {
  const { clips, commercial, currentClipId, direction, historyIds } = input
  const avoided = new Set(direction?.avoidTags)

  const eligible = (clip: CandidateClip): boolean =>
    clip.id !== currentClipId &&
    (!commercial || clip.commercialOk) &&
    (direction?.engine === undefined || clip.engine === direction.engine) &&
    (clip.tags ?? []).every((tag) => !avoided.has(tag))

  const recent = new Set(historyIds.slice(-RECENCY_WINDOW))
  const fresh = clips.filter((clip) => eligible(clip) && !recent.has(clip.id))

  return fresh.length >= MIN_CANDIDATES ? fresh : clips.filter(eligible)
}
