// SPDX-License-Identifier: AGPL-3.0-or-later

/** Wall-clock timing for a performance. All timestamps are `Date.now()` milliseconds: the control and output windows are separate documents and only wall-clock values are comparable between them. */
export interface Clock {
  bpm: number
  beatsPerBar: number
  /** A moment known to be the start of a bar; every other downbeat is derived from it. */
  downbeatAt: number
}

export const barDurationMs = (bpm: number, beatsPerBar = 4): number => (60_000 / bpm) * beatsPerBar

/** Where `now` falls inside its bar, as 0 (the downbeat) up to but never including 1. */
export const barPhase = (clock: Clock, now: number): number => {
  const bar = barDurationMs(clock.bpm, clock.beatsPerBar)
  const offset = (now - clock.downbeatAt) % bar

  return ((offset + bar) % bar) / bar
}

/** The next downbeat strictly after `now`. On a downbeat it returns the following one, so "Go" pressed on the beat lands on the next bar rather than firing instantly. */
export const nextBarAt = (clock: Clock, now: number): number => {
  const bar = barDurationMs(clock.bpm, clock.beatsPerBar)
  const barsElapsed = Math.floor((now - clock.downbeatAt) / bar)

  return clock.downbeatAt + (barsElapsed + 1) * bar
}

/** Mean interval between taps, as a tempo. Fewer than two taps say nothing. */
export const bpmFromTaps = (taps: number[]): number | undefined => {
  const [first] = taps
  const last = taps.at(-1)

  if (first === undefined || last === undefined || taps.length < 2) {
    return undefined
  }

  return 60_000 / ((last - first) / (taps.length - 1))
}
