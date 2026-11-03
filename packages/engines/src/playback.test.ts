// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'

import type { Clock } from './clock.ts'
import type { PlaybackState } from './playback.ts'
import {
  canBack,
  canGo,
  canGoNow,
  canQueue,
  canSetTransition,
  initialPlayback,
  isHeld,
  panicMode,
  reduce,
} from './playback.ts'

const clock: Clock = { beatsPerBar: 4, bpm: 120, downbeatAt: 0 }
const cut = { bars: 0, kind: 'cut' } as const
const start = () => initialPlayback('quiet', cut)

/** A clip staged and already rendered, so a switch to it may fire. `select-next` alone is only half of that. */
const stagedReady = (state: PlaybackState, clipId: string): PlaybackState =>
  reduce(reduce(state, { clipId, kind: 'select-next' }, clock), { kind: 'next-ready' }, clock)

describe('playback', () => {
  it('starts with one clip in slot a and nothing queued', () => {
    const state = start()
    expect(state.current).toStrictEqual({ clipId: 'quiet', slot: 'a' })
    expect(state.next).toBeUndefined()
    expect(state.firing).toBeUndefined()
  })

  it('queues a chosen clip into the free slot', () => {
    const state = stagedReady(start(), 'loud')
    expect(state.next).toMatchObject({ clipId: 'loud', slot: 'b' })
  })

  it('arms Go for the next bar, not for now', () => {
    let state = stagedReady(start(), 'loud')
    state = reduce(state, { kind: 'go', now: 2500 }, clock)
    // 120bpm → a 2000ms bar; 2500 sits mid-bar, so the next downbeat is 4000.
    expect(state.firing?.at).toBe(4000)
  })

  it('does not switch before the armed bar arrives', () => {
    let state = stagedReady(start(), 'loud')
    state = reduce(state, { kind: 'go', now: 2500 }, clock)
    state = reduce(state, { kind: 'tick', now: 3999 }, clock)
    expect(state.current.clipId).toBe('quiet')
  })

  it('switches exactly when the armed bar arrives, swapping the slots', () => {
    let state = stagedReady(start(), 'loud')
    state = reduce(state, { kind: 'go', now: 2500 }, clock)
    state = reduce(state, { kind: 'tick', now: 4000 }, clock)
    expect(state.current).toStrictEqual({ clipId: 'loud', slot: 'b' })
    expect(state.next).toBeUndefined()
    expect(state.firing).toBeUndefined()
  })

  it('completes a running fade immediately on Go now rather than swallowing the press', () => {
    const fade = { bars: 4, kind: 'crossfade' } as const
    let state = initialPlayback('quiet', fade)
    state = stagedReady(state, 'loud')
    state = reduce(state, { kind: 'go', now: 0 }, clock)
    state = reduce(state, { kind: 'tick', now: 2000 }, clock)
    expect(state.fading).toBeDefined()
    state = reduce(state, { kind: 'go-now', now: 3000 }, clock)
    expect(state.current).toStrictEqual({ clipId: 'loud', slot: 'b' })
    expect(state.fading).toBeUndefined()
  })

  it('fires immediately on Go now, without waiting for a bar', () => {
    let state = stagedReady(start(), 'loud')
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
    let state = stagedReady(start(), 'loud')
    state = reduce(state, { kind: 'go', now: 2500 }, clock)
    state = reduce(state, { clipId: 'other', kind: 'select-next' }, clock)
    expect(state.next?.clipId).toBe('other')
    expect(state.firing?.at).toBe(4000)
  })

  it('holds a crossfade across its bars before completing', () => {
    const fade = { bars: 2, kind: 'crossfade' } as const
    let state = initialPlayback('quiet', fade)
    state = stagedReady(state, 'loud')
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
    state = stagedReady(state, 'loud')
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
    state = stagedReady(state, 'loud')
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
    state = stagedReady(state, 'loud')
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
    state = stagedReady(state, 'loud')
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
    let state = stagedReady(start(), 'loud')
    state = reduce(state, { kind: 'go', now: 2500 }, clock)
    const crossfade = { bars: 2, kind: 'crossfade' } as const
    state = reduce(state, { kind: 'set-transition', transition: crossfade }, clock)
    expect(state.transition).toStrictEqual(crossfade)
    expect(state.firing?.at).toBe(4000)
  })

  it('completes a held crossfade once its bars finish', () => {
    const fade = { bars: 2, kind: 'crossfade' } as const
    let state = initialPlayback('quiet', fade)
    state = stagedReady(state, 'loud')
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
  const queued = stagedReady(idle, 'loud')
  const armed = reduce(queued, { kind: 'go', now: 0 }, clock)

  const fadeIdle = initialPlayback('quiet', fade)
  const fadeQueued = stagedReady(fadeIdle, 'loud')
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
    expect(canQueue(state)).toBe(stagedReady(state, 'third') !== state)
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

describe('transport: hold, back and panic', () => {
  const advancedTo = (clipId: string): PlaybackState => {
    let state = stagedReady(start(), clipId)
    state = reduce(state, { kind: 'go-now', now: 0 }, clock)
    return reduce(state, { kind: 'tick', now: 0 }, clock)
  }

  it('Hold toggles the pause, and Go releases it', () => {
    let state = reduce(start(), { kind: 'hold' }, clock)
    expect(isHeld(state)).toBe(true)
    state = reduce(state, { kind: 'hold' }, clock)
    expect(isHeld(state)).toBe(false)

    state = stagedReady(state, 'loud')
    state = reduce(state, { kind: 'hold' }, clock)
    expect(isHeld(state)).toBe(true)
    state = reduce(state, { kind: 'go', now: 0 }, clock)
    expect(isHeld(state)).toBe(false)
  })

  it('Hold survives a switch landing and a Back, because neither is the performer releasing it', () => {
    let state = stagedReady(start(), 'loud')
    state = reduce(state, { kind: 'go', now: 0 }, clock)
    state = reduce(state, { kind: 'hold' }, clock)
    state = reduce(state, { kind: 'tick', now: 2000 }, clock)
    expect(isHeld(state)).toBe(true)

    state = reduce(state, { kind: 'back' }, clock)
    expect(isHeld(state)).toBe(true)
  })

  it('records the transition a switch landed with', () => {
    let state = stagedReady(start(), 'loud')
    expect(state.arrivedBy).toBeUndefined()
    state = reduce(state, { kind: 'set-transition', transition: fade }, clock)
    state = reduce(state, { kind: 'go', now: 0 }, clock)
    state = reduce(state, { kind: 'tick', now: 2000 }, clock)
    state = reduce(state, { kind: 'tick', now: 6000 }, clock)
    expect(state.current.clipId).toBe('loud')
    expect(state.arrivedBy).toStrictEqual(fade)
  })

  it('records a cut for Back whatever transition is set', () => {
    let state = stagedReady(start(), 'loud')
    state = reduce(state, { kind: 'set-transition', transition: fade }, clock)
    state = reduce(state, { kind: 'go-now', now: 0 }, clock)
    state = reduce(state, { kind: 'tick', now: 0 }, clock)
    state = reduce(state, { kind: 'tick', now: 4000 }, clock)
    expect(state.arrivedBy).toStrictEqual(fade)

    state = reduce(state, { kind: 'back' }, clock)
    expect(state.current.clipId).toBe('quiet')
    expect(state.arrivedBy).toStrictEqual(cut)
  })

  it('Back refuses with no previous clip, changing nothing', () => {
    const before = start()
    expect(canBack(before)).toBe(false)
    expect(reduce(before, { kind: 'back' }, clock)).toBe(before)
  })

  it('Back returns to the previous clip in the free buffer and drops anything queued', () => {
    let state = advancedTo('loud')
    expect(state.current).toStrictEqual({ clipId: 'loud', slot: 'b' })
    state = stagedReady(state, 'third')
    expect(state.next?.clipId).toBe('third')

    state = reduce(state, { kind: 'back' }, clock)
    expect(state.current).toStrictEqual({ clipId: 'quiet', slot: 'a' })
    expect(state.next).toBeUndefined()
    expect(canBack(state)).toBe(false)
  })

  it('Back walks deeper than the two buffers, one clip per press', () => {
    let state = advancedTo('loud')
    state = stagedReady(state, 'third')
    state = reduce(state, { kind: 'go-now', now: 0 }, clock)
    state = reduce(state, { kind: 'tick', now: 0 }, clock)
    expect(state.current).toStrictEqual({ clipId: 'third', slot: 'a' })

    state = reduce(state, { kind: 'back' }, clock)
    expect(state.current).toStrictEqual({ clipId: 'loud', slot: 'b' })
    state = reduce(state, { kind: 'back' }, clock)
    expect(state.current).toStrictEqual({ clipId: 'quiet', slot: 'a' })
  })

  it('refuses Back mid-fade rather than interrupting a transition already in flight', () => {
    const state = advancedTo('loud')
    let fading = stagedReady(state, 'third')
    fading = reduce(fading, { kind: 'set-transition', transition: fade }, clock)
    fading = reduce(fading, { kind: 'go', now: 0 }, clock)
    fading = reduce(fading, { kind: 'tick', now: 2000 }, clock)
    expect(fading.fading).toBeDefined()

    expect(canBack(fading)).toBe(false)
    expect(reduce(fading, { kind: 'back' }, clock)).toBe(fading)
  })

  it('Blackout and Freeze toggle independently and swap modes', () => {
    let state = start()
    expect(panicMode(state)).toBe('none')
    state = reduce(state, { kind: 'blackout' }, clock)
    expect(panicMode(state)).toBe('blackout')
    state = reduce(state, { kind: 'freeze' }, clock)
    expect(panicMode(state)).toBe('freeze')
    state = reduce(state, { kind: 'freeze' }, clock)
    expect(panicMode(state)).toBe('none')
    state = reduce(state, { kind: 'blackout' }, clock)
    state = reduce(state, { kind: 'blackout' }, clock)
    expect(panicMode(state)).toBe('none')
  })

  it('canBack matches whether reduce accepts back in every state', () => {
    let state = start()
    state = stagedReady(state, 'loud')
    state = reduce(state, { kind: 'go', now: 0 }, clock)
    const armed = state
    const landed = reduce(armed, { kind: 'tick', now: 2000 }, clock)
    for (const each of [start(), armed, landed]) {
      expect(canBack(each)).toBe(reduce(each, { kind: 'back' }, clock) !== each)
    }
  })
})

describe('choosing a clip', () => {
  const fadingTo = (clipId: string): PlaybackState => {
    let state = initialPlayback('quiet', fade)
    state = stagedReady(state, clipId)
    state = reduce(state, { kind: 'go', now: 0 }, clock)
    return reduce(state, { kind: 'tick', now: 2000 }, clock)
  }

  it('stages the clip into the free slot and arms the next bar, with no Go', () => {
    const state = reduce(start(), { clipId: 'loud', kind: 'choose', now: 2500 }, clock)
    expect(state.next).toMatchObject({ clipId: 'loud', slot: 'b' })
    expect(state.firing?.at).toBe(4000)
  })

  it('replaces an armed choice and keeps its bar, needing the new clip to render again', () => {
    let state = reduce(start(), { clipId: 'loud', kind: 'choose', now: 2500 }, clock)
    state = reduce(state, { kind: 'next-ready' }, clock)
    state = reduce(state, { clipId: 'other', kind: 'choose', now: 3000 }, clock)
    expect(state.next).toStrictEqual({ clipId: 'other', ready: false, slot: 'b' })
    expect(state.firing?.at).toBe(4000)
  })

  it('choosing the clip already staged keeps its rendered slot, so a default Next can fire at once', () => {
    let state = stagedReady(start(), 'loud')
    state = reduce(state, { clipId: 'loud', kind: 'choose', now: 2500 }, clock)
    expect(state.next?.ready).toBe(true)
    expect(state.firing?.at).toBe(4000)
  })

  it('releases Hold, because choosing is an explicit advance like Go', () => {
    let state = reduce(start(), { kind: 'hold' }, clock)
    state = reduce(state, { clipId: 'loud', kind: 'choose', now: 2500 }, clock)
    expect(isHeld(state)).toBe(false)
  })

  it('during a fade holds the choice and leaves the fade alone', () => {
    const before = fadingTo('loud')
    const state = reduce(before, { clipId: 'other', kind: 'choose', now: 3000 }, clock)
    expect(state.chosen).toBe('other')
    expect(state.fading).toStrictEqual(before.fading)
    expect(state.next?.clipId).toBe('loud')
    expect(state.firing).toBeUndefined()
  })

  it('fires a held choice on the bar after the fade lands, not before', () => {
    let state = fadingTo('loud')
    state = reduce(state, { clipId: 'other', kind: 'choose', now: 3000 }, clock)
    state = reduce(state, { kind: 'tick', now: 6000 }, clock)

    expect(state.current.clipId).toBe('loud')
    expect(state.next).toStrictEqual({ clipId: 'other', ready: false, slot: 'a' })
    expect(state.firing?.at).toBe(8000)
    expect(state.chosen).toBeUndefined()
  })

  it('a second choice during the fade replaces the first', () => {
    let state = fadingTo('loud')
    state = reduce(state, { clipId: 'other', kind: 'choose', now: 3000 }, clock)
    state = reduce(state, { clipId: 'third', kind: 'choose', now: 3500 }, clock)
    state = reduce(state, { kind: 'tick', now: 6000 }, clock)
    expect(state.next?.clipId).toBe('third')
  })

  it('choosing the clip the fade is bringing in arms nothing when it lands', () => {
    let state = fadingTo('loud')
    state = reduce(state, { clipId: 'loud', kind: 'choose', now: 3000 }, clock)
    state = reduce(state, { kind: 'tick', now: 6000 }, clock)
    expect(state.current.clipId).toBe('loud')
    expect(state.next).toBeUndefined()
    expect(state.firing).toBeUndefined()
  })

  it('choosing the armed clip again before the bar cancels the choice and leaves the picture alone', () => {
    let state = reduce(start(), { clipId: 'loud', kind: 'choose', now: 2500 }, clock)
    state = reduce(state, { kind: 'next-ready' }, clock)
    state = reduce(state, { clipId: 'loud', kind: 'choose', now: 3000 }, clock)

    expect(state.next).toBeUndefined()
    expect(state.firing).toBeUndefined()
    state = reduce(state, { kind: 'tick', now: 4000 }, clock)
    expect(state.current).toStrictEqual({ clipId: 'quiet', slot: 'a' })
  })

  it('a cancelled choice can be made again, and arms the next bar afresh', () => {
    let state = reduce(start(), { clipId: 'loud', kind: 'choose', now: 2500 }, clock)
    state = reduce(state, { clipId: 'loud', kind: 'choose', now: 2600 }, clock)
    state = reduce(state, { clipId: 'loud', kind: 'choose', now: 4100 }, clock)

    expect(state.next).toMatchObject({ clipId: 'loud', ready: false })
    expect(state.firing?.at).toBe(6000)
  })

  it('choosing a different clip is a replacement, not a cancel', () => {
    let state = reduce(start(), { clipId: 'loud', kind: 'choose', now: 2500 }, clock)
    state = reduce(state, { clipId: 'other', kind: 'choose', now: 3000 }, clock)

    expect(state.next?.clipId).toBe('other')
    expect(state.firing?.at).toBe(4000)
  })

  it('choosing a staged clip that nothing has armed arms it, as it always did', () => {
    let state = stagedReady(start(), 'loud')
    state = reduce(state, { clipId: 'loud', kind: 'choose', now: 2500 }, clock)

    expect(state.firing?.at).toBe(4000)
    expect(state.next?.clipId).toBe('loud')
  })

  it('cancelling leaves Hold as the performer last set it', () => {
    let state = reduce(start(), { clipId: 'loud', kind: 'choose', now: 2500 }, clock)
    state = reduce(state, { kind: 'hold' }, clock)
    state = reduce(state, { clipId: 'loud', kind: 'choose', now: 3000 }, clock)

    expect(isHeld(state)).toBe(true)
  })

  it('choosing the same clip twice during a fade drops the held choice, and nothing is armed at the landing', () => {
    let state = fadingTo('loud')
    state = reduce(state, { clipId: 'other', kind: 'choose', now: 3000 }, clock)
    state = reduce(state, { clipId: 'other', kind: 'choose', now: 3500 }, clock)

    expect(state.chosen).toBeUndefined()
    expect(state.fading).toBeDefined()
    state = reduce(state, { kind: 'tick', now: 6000 }, clock)
    expect(state.current.clipId).toBe('loud')
    expect(state.next).toBeUndefined()
    expect(state.firing).toBeUndefined()
  })

  it('a Hold pressed after a choice made in a fade survives the landing, and the choice still fires', () => {
    let state = fadingTo('loud')
    state = reduce(state, { clipId: 'other', kind: 'choose', now: 3000 }, clock)
    state = reduce(state, { kind: 'hold' }, clock)
    state = reduce(state, { kind: 'tick', now: 6000 }, clock)

    expect(isHeld(state)).toBe(true)
    // Hold pauses automatic advance. It does not take back a switch the performer already asked for.
    expect(state.next).toMatchObject({ clipId: 'other' })
    expect(state.firing?.at).toBe(8000)
  })

  it('a choice made after a Hold, in a fade, still releases it at the landing', () => {
    let state = fadingTo('loud')
    state = reduce(state, { kind: 'hold' }, clock)
    state = reduce(state, { clipId: 'other', kind: 'choose', now: 3000 }, clock)
    state = reduce(state, { kind: 'tick', now: 6000 }, clock)

    expect(isHeld(state)).toBe(false)
  })

  it('Go now over a fade finishes it and arms the held choice', () => {
    let state = fadingTo('loud')
    state = reduce(state, { clipId: 'other', kind: 'choose', now: 3000 }, clock)
    state = reduce(state, { kind: 'go-now', now: 3100 }, clock)
    expect(state.current.clipId).toBe('loud')
    expect(state.next?.clipId).toBe('other')
    expect(state.firing?.at).toBe(4000)
  })
})

describe('a switch never fires onto a slot that has not rendered', () => {
  it('slips to the following bar when the clip is not ready at the bar line', () => {
    let state = reduce(start(), { clipId: 'loud', kind: 'choose', now: 3999 }, clock)
    state = reduce(state, { kind: 'tick', now: 4000 }, clock)
    expect(state.current.clipId).toBe('quiet')
    expect(state.firing?.at).toBe(6000)
  })

  it('fires on that following bar once the clip has rendered', () => {
    let state = reduce(start(), { clipId: 'loud', kind: 'choose', now: 3999 }, clock)
    state = reduce(state, { kind: 'tick', now: 4000 }, clock)
    state = reduce(state, { kind: 'next-ready' }, clock)
    state = reduce(state, { kind: 'tick', now: 5999 }, clock)
    expect(state.current.clipId).toBe('quiet')
    state = reduce(state, { kind: 'tick', now: 6000 }, clock)
    expect(state.current.clipId).toBe('loud')
  })

  it('a Go on a slot that has not rendered slips the same way', () => {
    let state = reduce(start(), { clipId: 'loud', kind: 'select-next' }, clock)
    state = reduce(state, { kind: 'go', now: 2500 }, clock)
    state = reduce(state, { kind: 'tick', now: 4000 }, clock)
    expect(state.current.clipId).toBe('quiet')
    expect(state.firing?.at).toBe(6000)
  })

  it('Go now waits only for the render, and starts its fade from the frame it fires on', () => {
    let state = initialPlayback('quiet', fade)
    state = reduce(state, { clipId: 'loud', kind: 'select-next' }, clock)
    state = reduce(state, { kind: 'go-now', now: 2500 }, clock)
    state = reduce(state, { kind: 'tick', now: 2516 }, clock)
    expect(state.fading).toBeUndefined()
    expect(state.firing?.at).toBe(2500)

    state = reduce(state, { kind: 'next-ready' }, clock)
    state = reduce(state, { kind: 'tick', now: 2532 }, clock)
    expect(state.fading?.startedAt).toBe(2532)
  })

  it('a re-chosen clip must render again before the armed bar', () => {
    let state = reduce(start(), { clipId: 'loud', kind: 'choose', now: 2500 }, clock)
    state = reduce(state, { kind: 'next-ready' }, clock)
    state = reduce(state, { clipId: 'other', kind: 'choose', now: 3999 }, clock)
    state = reduce(state, { kind: 'tick', now: 4000 }, clock)
    expect(state.current.clipId).toBe('quiet')
    expect(state.next?.clipId).toBe('other')
    expect(state.firing?.at).toBe(6000)
  })

  it('unstage clears what cannot be played, armed or not', () => {
    let state = reduce(start(), { clipId: 'broken', kind: 'choose', now: 2500 }, clock)
    state = reduce(state, { kind: 'unstage' }, clock)
    expect(state.next).toBeUndefined()
    expect(state.firing).toBeUndefined()
  })

  it('next-ready with nothing staged changes nothing', () => {
    const before = start()
    expect(reduce(before, { kind: 'next-ready' }, clock)).toBe(before)
  })
})

describe('Freeze holds a switch', () => {
  it('an armed switch slips past its bar while frozen, so the picture and the state agree', () => {
    let state = stagedReady(start(), 'loud')
    state = reduce(state, { kind: 'go', now: 2500 }, clock)
    state = reduce(state, { kind: 'freeze' }, clock)
    state = reduce(state, { kind: 'tick', now: 4000 }, clock)
    expect(state.current.clipId).toBe('quiet')
    expect(state.firing?.at).toBe(6000)
  })

  it('fires on the first bar after the freeze lifts', () => {
    let state = stagedReady(start(), 'loud')
    state = reduce(state, { kind: 'go', now: 2500 }, clock)
    state = reduce(state, { kind: 'freeze' }, clock)
    state = reduce(state, { kind: 'tick', now: 4000 }, clock)
    state = reduce(state, { kind: 'freeze' }, clock)
    state = reduce(state, { kind: 'tick', now: 6000 }, clock)
    expect(state.current.clipId).toBe('loud')
  })

  it('Go now under a freeze fires on the first frame after it lifts', () => {
    let state = stagedReady(start(), 'loud')
    state = reduce(state, { kind: 'freeze' }, clock)
    state = reduce(state, { kind: 'go-now', now: 2500 }, clock)
    state = reduce(state, { kind: 'tick', now: 3000 }, clock)
    expect(state.current.clipId).toBe('quiet')
    state = reduce(state, { kind: 'freeze' }, clock)
    state = reduce(state, { kind: 'tick', now: 3016 }, clock)
    expect(state.current.clipId).toBe('loud')
  })

  it('Blackout does not hold a switch: the picture is still current underneath', () => {
    let state = stagedReady(start(), 'loud')
    state = reduce(state, { kind: 'go', now: 2500 }, clock)
    state = reduce(state, { kind: 'blackout' }, clock)
    state = reduce(state, { kind: 'tick', now: 4000 }, clock)
    expect(state.current.clipId).toBe('loud')
  })
})
