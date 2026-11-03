// SPDX-License-Identifier: AGPL-3.0-or-later
import type { TransitionSpec } from '@vev/shared'

import { barDurationMs } from './clock.ts'
import type { Clock } from './clock.ts'

/**
 * How far through a transition `now` is, as 0 to 1.
 *
 * Derived from wall-clock timestamps rather than accumulated frame deltas, so the reducer and the
 * picture agree on when a fade ends, and a dropped frame does not shorten it.
 */
export const fadeProgress = (spec: TransitionSpec, startedAt: number, now: number, clock: Clock): number => {
  const span = barDurationMs(clock.bpm, clock.beatsPerBar) * spec.bars
  if (span <= 0) {
    return 1
  }

  return Math.min(1, Math.max(0, (now - startedAt) / span))
}
