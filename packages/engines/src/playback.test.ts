// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'

import type { Clock } from './clock.ts'
import { initialPlayback, reduce } from './playback.ts'

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
