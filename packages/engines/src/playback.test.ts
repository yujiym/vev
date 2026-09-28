// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'

import type { Clock } from './clock.ts'
import type { PlaybackState } from './playback.ts'
import { canGo, canGoNow, canQueue, canSetTransition, initialPlayback, reduce } from './playback.ts'

const clock: Clock = { beatsPerBar: 4, bpm: 120, downbeatAt: 0 }
const cut = { bars: 0, kind: 'cut' } as const
const start = () => initialPlayback('quiet', cut)

describe('playback', () => {
  it('starts with one clip in slot a and nothing queued', () => {
    const state = start()
    expect(state.current).toStrictEqual({ clipId: 'quiet', slot: 'a' })
    expect(state.next).toBeUndefined()
    expect(state.firing).toBeUndefined()
  })

  it('queues a chosen clip into the free slot', () => {
    const state = reduce(start(), { clipId: 'loud', kind: 'select-next' }, clock)
    expect(state.next).toStrictEqual({ clipId: 'loud', slot: 'b' })
  })

  it('arms Go for the next bar, not for now', () => {
    let state = reduce(start(), { clipId: 'loud', kind: 'select-next' }, clock)
    state = reduce(state, { kind: 'go', now: 2500 }, clock)
    // 120bpm → a 2000ms bar; 2500 sits mid-bar, so the next downbeat is 4000.
    expect(state.firing?.at).toBe(4000)
  })

  it('does not switch before the armed bar arrives', () => {
    let state = reduce(start(), { clipId: 'loud', kind: 'select-next' }, clock)
    state = reduce(state, { kind: 'go', now: 2500 }, clock)
    state = reduce(state, { kind: 'tick', now: 3999 }, clock)
    expect(state.current.clipId).toBe('quiet')
  })

  it('switches exactly when the armed bar arrives, swapping the slots', () => {
    let state = reduce(start(), { clipId: 'loud', kind: 'select-next' }, clock)
    state = reduce(state, { kind: 'go', now: 2500 }, clock)
    state = reduce(state, { kind: 'tick', now: 4000 }, clock)
    expect(state.current).toStrictEqual({ clipId: 'loud', slot: 'b' })
    expect(state.next).toBeUndefined()
    expect(state.firing).toBeUndefined()
  })

  it('completes a running fade immediately on Go now rather than swallowing the press', () => {
    const fade = { bars: 4, kind: 'crossfade' } as const
    let state = initialPlayback('quiet', fade)
    state = reduce(state, { clipId: 'loud', kind: 'select-next' }, clock)
    state = reduce(state, { kind: 'go', now: 0 }, clock)
    state = reduce(state, { kind: 'tick', now: 2000 }, clock)
    expect(state.fading).toBeDefined()
    state = reduce(state, { kind: 'go-now', now: 3000 }, clock)
    expect(state.current).toStrictEqual({ clipId: 'loud', slot: 'b' })
    expect(state.fading).toBeUndefined()
  })

  it('fires immediately on Go now, without waiting for a bar', () => {
    let state = reduce(start(), { clipId: 'loud', kind: 'select-next' }, clock)
    state = reduce(state, { kind: 'go-now', now: 2500 }, clock)
    expect(state.firing?.at).toBe(2500)
    state = reduce(state, { kind: 'tick', now: 2500 }, clock)
    expect(state.current.clipId).toBe('loud')
  })

  it('ignores Go when nothing is queued', () => {
    const state = reduce(start(), { kind: 'go', now: 2500 }, clock)
    expect(state.firing).toBeUndefined()
  })

  it('replaces the queued clip while Go is still armed, keeping the armed moment', () => {
    let state = reduce(start(), { clipId: 'loud', kind: 'select-next' }, clock)
    state = reduce(state, { kind: 'go', now: 2500 }, clock)
    state = reduce(state, { clipId: 'other', kind: 'select-next' }, clock)
    expect(state.next?.clipId).toBe('other')
    expect(state.firing?.at).toBe(4000)
  })

  it('holds a crossfade across its bars before completing', () => {
    const fade = { bars: 2, kind: 'crossfade' } as const
    let state = initialPlayback('quiet', fade)
    state = reduce(state, { clipId: 'loud', kind: 'select-next' }, clock)
    state = reduce(state, { kind: 'go', now: 0 }, clock)
    expect(state.firing?.at).toBe(2000)
    state = reduce(state, { kind: 'tick', now: 2000 }, clock)
    expect(state.current.clipId).toBe('quiet')
    expect(state.fading).toStrictEqual({ from: 'a', startedAt: 2000, to: 'b' })
    state = reduce(state, { kind: 'tick', now: 4000 }, clock)
    expect(state.current.clipId).toBe('quiet')
  })

  it('refuses Go while a fade is running, changing nothing', () => {
    const fade = { bars: 2, kind: 'crossfade' } as const
    let state = initialPlayback('quiet', fade)
    state = reduce(state, { clipId: 'loud', kind: 'select-next' }, clock)
    state = reduce(state, { kind: 'go', now: 0 }, clock)
    state = reduce(state, { kind: 'tick', now: 2000 }, clock)
    expect(state.fading).toBeDefined()

    const before = state
    state = reduce(state, { kind: 'go', now: 2500 }, clock)
    expect(state).toStrictEqual(before)
  })

  it("refuses to queue a new clip while a fade is running, leaving `next` as the fade's own destination", () => {
    const fade = { bars: 2, kind: 'crossfade' } as const
    let state = initialPlayback('quiet', fade)
    state = reduce(state, { clipId: 'loud', kind: 'select-next' }, clock)
    state = reduce(state, { kind: 'go', now: 0 }, clock)
    state = reduce(state, { kind: 'tick', now: 2000 }, clock)
    expect(state.fading).toBeDefined()

    const before = state
    state = reduce(state, { clipId: 'other', kind: 'select-next' }, clock)
    expect(state).toStrictEqual(before)
    expect(state.next?.clipId).toBe('loud')
  })

  it('refuses to change the transition kind while a fade is running', () => {
    const fade = { bars: 2, kind: 'crossfade' } as const
    let state = initialPlayback('quiet', fade)
    state = reduce(state, { clipId: 'loud', kind: 'select-next' }, clock)
    state = reduce(state, { kind: 'go', now: 0 }, clock)
    state = reduce(state, { kind: 'tick', now: 2000 }, clock)
    expect(state.fading).toBeDefined()

    state = reduce(state, { kind: 'set-transition', transition: cut }, clock)
    expect(state.transition).toStrictEqual(fade)
    expect(state.fading).toBeDefined()
  })

  it('a refused mid-fade transition change does not shorten or complete the fade early', () => {
    const fade = { bars: 2, kind: 'crossfade' } as const
    let state = initialPlayback('quiet', fade)
    state = reduce(state, { clipId: 'loud', kind: 'select-next' }, clock)
    state = reduce(state, { kind: 'go', now: 0 }, clock)
    state = reduce(state, { kind: 'tick', now: 2000 }, clock)
    state = reduce(state, { kind: 'set-transition', transition: cut }, clock)

    // A `cut` transition's `bars` is 0, which `tick` treats as instantly due —
    // if the toggle above had taken effect, this tick would already show 'loud'.
    state = reduce(state, { kind: 'tick', now: 3000 }, clock)
    expect(state.current.clipId).toBe('quiet')
    expect(state.fading).toBeDefined()

    // The fade's original 2-bar span (4000ms) started at 2000, so it completes at 6000.
    state = reduce(state, { kind: 'tick', now: 6000 }, clock)
    expect(state.current).toStrictEqual({ clipId: 'loud', slot: 'b' })
  })

  it('allows changing the transition kind while Go is armed but not yet fading', () => {
    let state = reduce(start(), { clipId: 'loud', kind: 'select-next' }, clock)
    state = reduce(state, { kind: 'go', now: 2500 }, clock)
    const crossfade = { bars: 2, kind: 'crossfade' } as const
    state = reduce(state, { kind: 'set-transition', transition: crossfade }, clock)
    expect(state.transition).toStrictEqual(crossfade)
    expect(state.firing?.at).toBe(4000)
  })

  it('completes a held crossfade once its bars finish', () => {
    const fade = { bars: 2, kind: 'crossfade' } as const
    let state = initialPlayback('quiet', fade)
    state = reduce(state, { clipId: 'loud', kind: 'select-next' }, clock)
    state = reduce(state, { kind: 'go', now: 0 }, clock)
    state = reduce(state, { kind: 'tick', now: 2000 }, clock)
    // Still mid-fade one bar before the two-bar span is up: a fade that completes
    // early would already show 'loud' here, so this assertion — not just the final
    // one below — is what a shortened span breaks.
    state = reduce(state, { kind: 'tick', now: 4000 }, clock)
    expect(state.current.clipId).toBe('quiet')
    expect(state.fading).toBeDefined()
    state = reduce(state, { kind: 'tick', now: 6000 }, clock)
    expect(state.current).toStrictEqual({ clipId: 'loud', slot: 'b' })
    expect(state.fading).toBeUndefined()
  })
})

/**
 * The predicates and `reduce` must agree by construction, not by inspection. `reduce` returns the
 * SAME state object when it refuses an event, so "would this be refused?" is decidable — and each
 * test below asserts the predicate equals that, over every interesting state rather than over one
 * hand-picked example. A panel that disables on these predicates is then correct by the same
 * proof: this is the divergence that cost M1 three fix rounds.
 */
const fade = { bars: 2, kind: 'crossfade' } as const

/** Every state worth asking the question in: idle, queued, armed, mid-fade, and armed-with-a-cut. */
const STATES = (): { name: string; state: PlaybackState }[] => {
  const idle = initialPlayback('quiet', cut)
  const queued = reduce(idle, { clipId: 'loud', kind: 'select-next' }, clock)
  const armed = reduce(queued, { kind: 'go', now: 0 }, clock)

  const fadeIdle = initialPlayback('quiet', fade)
  const fadeQueued = reduce(fadeIdle, { clipId: 'loud', kind: 'select-next' }, clock)
  const fadeArmed = reduce(fadeQueued, { kind: 'go', now: 0 }, clock)
  const fading = reduce(fadeArmed, { kind: 'tick', now: 2000 }, clock)

  return [
    { name: 'idle, nothing queued', state: idle },
    { name: 'something queued', state: queued },
    { name: 'armed for the next bar', state: armed },
    { name: 'armed with a crossfade', state: fadeArmed },
    { name: 'mid-crossfade', state: fading },
  ]
}

describe('the control predicates and reduce agree', () => {
  it('mid-crossfade really is one of the states under test', () => {
    const fading = STATES().find((entry) => entry.name === 'mid-crossfade')
    expect(fading?.state.fading).toBeDefined()
  })

  it.each(STATES())('canGo matches whether reduce accepts go — $name', ({ state }) => {
    expect(canGo(state)).toBe(reduce(state, { kind: 'go', now: 0 }, clock) !== state)
  })

  it.each(STATES())('canQueue matches whether reduce accepts select-next — $name', ({ state }) => {
    expect(canQueue(state)).toBe(reduce(state, { clipId: 'third', kind: 'select-next' }, clock) !== state)
  })

  it.each(STATES())('canSetTransition matches whether reduce accepts set-transition — $name', ({ state }) => {
    expect(canSetTransition(state)).toBe(
      reduce(state, { kind: 'set-transition', transition: fade }, clock) !== state,
    )
  })

  it.each(STATES())('canGoNow matches whether reduce accepts go-now — $name', ({ state }) => {
    expect(canGoNow(state)).toBe(reduce(state, { kind: 'go-now', now: 0 }, clock) !== state)
  })

  it('refuses Go once one is already armed, which a fade-only guard would allow', () => {
    const armed = STATES().find((entry) => entry.name === 'armed for the next bar')
    expect(armed?.state.fading).toBeUndefined()
    expect(canGo(armed!.state)).toBe(false)
  })

  it('refuses Go with nothing queued, which a fade-only guard would also allow', () => {
    expect(canGo(initialPlayback('quiet', cut))).toBe(false)
  })
})
