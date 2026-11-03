// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CandidateRequest, CandidateResponse, Clip, ClipSummary, TransitionSpec } from '@vev/shared'
import { describe, expect, it, vi } from 'vitest'

import type { Control, PlayableClip } from './control.ts'
import { createControl } from './control.ts'
import type { ClipMeta, NextInput } from './live.ts'
import {
  applyCandidates,
  beginRequest,
  chooseTransitionManually,
  createLive,
  decisionStatus,
  failRequest,
  initialLive,
  keyAction,
  nextTransitionChoice,
  pickCandidate,
  pushHistory,
  selectNext,
} from './live.ts'

const FADE: TransitionSpec = { bars: 2, kind: 'crossfade' }
const CUT: TransitionSpec = { bars: 0, kind: 'cut' }

const candidate = (clipId: string, overrides: Partial<CandidateResponse['candidates'][number]> = {}) => ({
  clipId,
  reason: `tag ${clipId}`,
  score: 0.5,
  source: 'fallback' as const,
  ...overrides,
})

const response = (ids: readonly string[], transition: TransitionSpec = FADE): CandidateResponse => ({
  candidates: ids.map((id) => candidate(id)),
  suggestedTransition: transition,
})

const meta = (id: string, overrides: Partial<ClipMeta> = {}): ClipMeta => ({
  annotationStatus: 'ok',
  energy: 3,
  engine: 'hydra',
  reviewed: true,
  title: `title ${id}`,
  ...overrides,
})

const loaded = (ids: readonly string[], transition: TransitionSpec = FADE) => {
  const state = beginRequest(initialLive(), 'current')
  return applyCandidates(
    state,
    state.requestId,
    response(ids, transition),
    new Map(ids.map((id) => [id, meta(id)])),
  )
}

const nextInput = (overrides: Partial<NextInput> = {}): NextInput => ({
  current: meta('current', { energy: 2 }),
  currentClipId: 'current',
  defaultTransition: FADE,
  lookup: (id) => meta(id),
  recentTransitions: [],
  ...overrides,
})

const playable = (id: string, title = id.toUpperCase()): PlayableClip => ({
  code: 'osc().out()',
  id,
  title,
})
const summary = (id: string, title: string): ClipSummary => ({
  annotationStatus: 'ok',
  commercialOk: true,
  energy: 3,
  engine: 'hydra',
  id,
  license: 'CC0 1.0',
  reviewed: true,
  slug: id,
  title,
})
// SAFETY: the live screen reads only `id`, `code` and `title` from a fetched clip; the rest of the
// record is irrelevant to every assertion here.
const clip = (id: string, title = id.toUpperCase()): Clip =>
  ({ code: 'osc().out()', id, title }) as unknown as Clip
/** A fake network call: it settles after a microtask, as a real fetch does, never synchronously. */
const delayed = async <T>(value: T): Promise<T> => {
  await Promise.resolve()
  return value
}
const failing = async (message: string): Promise<never> => {
  await Promise.resolve()
  throw new Error(message)
}
const keyOf = (value: string, extra: { chatFocused?: boolean; shiftKey?: boolean } = {}) =>
  keyAction(
    { key: value, shiftKey: extra.shiftKey },
    { chatFocused: extra.chatFocused ?? false, textEntry: false },
  )

describe(applyCandidates, () => {
  it('joins each result to the library title, engine and thumbnail, and keeps the suggested transition', () => {
    const state = beginRequest(initialLive(), 'a')
    const clips = new Map([
      ['b', { ...meta('b'), thumbnailKey: 'thumbnails/b.webm' }],
      ['c', meta('c')],
    ])

    const next = applyCandidates(state, state.requestId, response(['b', 'c']), clips)

    expect(next.load).toBe('ok')
    expect(next.suggestedTransition).toStrictEqual(FADE)
    expect(next.candidates[0]).toMatchObject({
      clipId: 'b',
      engine: 'hydra',
      thumbnailUrl: '/media/thumbnails/b.webm',
      title: 'title b',
    })
    expect(next.candidates[1]?.thumbnailUrl).toBeUndefined()
  })

  it('ignores an answer that belongs to a superseded request', () => {
    const first = beginRequest(initialLive(), 'a')
    const second = beginRequest(first, 'a')

    const next = applyCandidates(second, first.requestId, response(['b']), new Map())

    expect(next).toBe(second)
  })

  it('keeps the last candidates but marks them stale when the request fails', () => {
    const ok = loaded(['b', 'c', 'd'])
    const next = failRequest(ok, ok.requestId, '404')

    expect(next.load).toBe('stale')
    expect(next.error).toBe('404')
    expect(next.candidates).toStrictEqual(ok.candidates)
  })

  it('drops a picked candidate that a new answer no longer offers', () => {
    const ok = pickCandidate(loaded(['b', 'c', 'd']), 'd')
    const refreshed = applyCandidates(
      beginRequest(ok, 'current'),
      ok.requestId + 1,
      response(['b', 'c']),
      new Map(),
    )

    expect(refreshed.pickedClipId).toBeUndefined()
  })
})

describe(selectNext, () => {
  it('offers candidate #1 after the end of a track, with the response’s transition', () => {
    const next = selectNext(loaded(['b', 'c', 'd']), nextInput())

    expect(next).toMatchObject({
      candidateIndex: 0,
      clipId: 'b',
      source: 'candidate',
      transition: FADE,
      transitionFrom: 'suggested',
    })
  })

  it('prefers the track’s own next item while the track still has one', () => {
    const next = selectNext(
      loaded(['b', 'c', 'd']),
      nextInput({ trackNext: { clipId: 'track-b', engine: 'hydra', locked: false, transition: CUT } }),
    )

    expect(next).toMatchObject({
      clipId: 'track-b',
      source: 'track',
      transition: CUT,
      transitionFrom: 'track',
    })
  })

  it('never re-chooses a locked track item’s transition', () => {
    const locked = { bars: 4, kind: 'crossfade' as const }
    const next = selectNext(
      loaded(['b']),
      nextInput({ trackNext: { clipId: 'track-b', engine: 'hydra', locked: true, transition: locked } }),
    )

    expect(next?.transition).toStrictEqual(locked)
    expect(next?.transitionFrom).toBe('locked')
  })

  it('uses the rules for a candidate the response did not rank first', () => {
    const picked = pickCandidate(loaded(['b', 'c', 'd'], CUT), 'c')
    const next = selectNext(picked, nextInput())

    expect(next).toMatchObject({ clipId: 'c', source: 'candidate' })
    expect(next?.transitionFrom).toBe('rules')
    expect(next?.transition).not.toStrictEqual(CUT)
  })

  it('lets the performer’s transition choice outrank the response’s suggestion', () => {
    const chosen = chooseTransitionManually(loaded(['b', 'c']), CUT)
    const next = selectNext(chosen, nextInput())

    expect(next?.transition).toStrictEqual(CUT)
    expect(next?.transitionFrom).toBe('performer')
  })

  it('passes recent transitions to the variety rule', () => {
    const picked = pickCandidate(loaded(['b', 'c', 'd'], CUT), 'c')
    const next = selectNext(
      picked,
      nextInput({
        current: meta('current', { energy: 1 }),
        lookup: (id) => meta(id, { energy: id === 'c' ? 4 : 2 }),
        recentTransitions: ['cut', 'cut', 'cut'],
      }),
    )

    expect(next?.transition.kind).toBe('crossfade')
  })

  it('never offers the clip already on screen, even from a stale answer', () => {
    const stale = loaded(['current', 'b', 'c'])
    const next = selectNext(stale, nextInput())

    expect(next?.clipId).toBe('b')
  })

  it('offers nothing when the only candidate is the current clip', () => {
    expect(selectNext(loaded(['current']), nextInput())).toBeUndefined()
  })
})

describe('the key map', () => {
  it.each([
    ['1', false, { index: 0, kind: 'select-candidate' }],
    ['2', false, { index: 1, kind: 'select-candidate' }],
    ['3', false, { index: 2, kind: 'select-candidate' }],
    [' ', false, { kind: 'go' }],
    [' ', true, { kind: 'go-now' }],
    ['h', false, { kind: 'hold' }],
    ['H', false, { kind: 'hold' }],
    ['b', false, { kind: 'blackout' }],
    ['Escape', false, { kind: 'freeze' }],
    ['c', false, { kind: 'chat' }],
  ])('maps %j (shift: %j) from spec §12.1', (value, shiftKey, action) => {
    expect(keyOf(value, { shiftKey })).toStrictEqual(action)
  })

  it('suspends every single-key shortcut while the chat has focus, except Esc closing it', () => {
    for (const value of ['1', '2', '3', ' ', 'h', 'b', 'c']) {
      expect(keyOf(value, { chatFocused: true })).toBeUndefined()
    }
    expect(keyOf('Escape', { chatFocused: true })).toStrictEqual({ kind: 'close-chat' })
  })

  it('leaves keys typed into a field alone', () => {
    expect(keyAction({ key: 'b' }, { chatFocused: false, textEntry: true })).toBeUndefined()
  })

  it('ignores modified keys so browser shortcuts still work', () => {
    expect(keyAction({ ctrlKey: true, key: 'b' }, { chatFocused: false, textEntry: false })).toBeUndefined()
    expect(keyAction({ key: 'b', metaKey: true }, { chatFocused: false, textEntry: false })).toBeUndefined()
  })
})

describe(nextTransitionChoice, () => {
  it('cycles cut → 1 → 2 → 4 bars → cut', () => {
    expect(nextTransitionChoice(CUT)).toStrictEqual({ bars: 1, kind: 'crossfade' })
    expect(nextTransitionChoice({ bars: 1, kind: 'crossfade' })).toStrictEqual({ bars: 2, kind: 'crossfade' })
    expect(nextTransitionChoice({ bars: 2, kind: 'crossfade' })).toStrictEqual({ bars: 4, kind: 'crossfade' })
    expect(nextTransitionChoice({ bars: 4, kind: 'crossfade' })).toStrictEqual(CUT)
  })
})

describe(decisionStatus, () => {
  it('names the provider when the model produced the top candidate', () => {
    const state = beginRequest(initialLive(), 'a')
    const answered = applyCandidates(
      state,
      state.requestId,
      {
        candidates: [candidate('b', { providerId: 'cf-jev', source: 'decision' })],
        suggestedTransition: FADE,
      },
      new Map(),
    )

    expect(decisionStatus(answered)).toStrictEqual({
      label: 'cf-jev',
      providerId: 'cf-jev',
      tone: 'decision',
    })
  })

  it('says the ranking is rules, not a model, for a fallback answer', () => {
    expect(decisionStatus(loaded(['b'])).tone).toBe('fallback')
  })

  it('says the candidates are stale rather than pretending they are current', () => {
    const stale = failRequest(loaded(['b']), beginRequest(initialLive(), 'a').requestId, 'offline')
    expect(decisionStatus(stale).tone).toBe('stale')
  })
})

describe(createLive, () => {
  const setup = (
    overrides: {
      fetchCandidates?: (body: CandidateRequest) => Promise<CandidateResponse>
    } = {},
  ) => {
    const published: unknown[] = []
    const control: Control = createControl(
      (message) => {
        published.push(message)
      },
      { clips: [playable('a', 'A'), playable('b', 'B'), playable('d', 'D')], startClipId: 'a' },
    )
    const bodies: CandidateRequest[] = []
    const fetchCandidates = overrides.fetchCandidates ?? (async () => await delayed(response(['b', 'd'])))

    const live = createLive({
      control,
      fetchCandidates: async (body) => {
        bodies.push(body)
        return await fetchCandidates(body)
      },
      fetchClipById: async (id) => await delayed(clip(id)),
      fetchLibrarySummaries: async () =>
        await delayed([summary('a', 'A'), summary('b', 'B'), summary('d', 'D')]),
    })

    return { bodies, control, live, published }
  }

  it('requests candidates as soon as the screen opens and names them from the library', async () => {
    const { bodies, live } = setup()

    await vi.waitFor(() => {
      expect(live.getSnapshot().live.candidates).toHaveLength(2)
    })

    expect(bodies[0]).toMatchObject({ currentClipId: 'a', historyIds: [] })
    expect(live.getSnapshot().live.candidates.map((entry) => entry.title)).toStrictEqual(['B', 'D'])
  })

  it('a candidate click replaces Next through the control window', async () => {
    const { control, live } = setup()
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.candidates).toHaveLength(2)
    })

    live.pickCandidate('d')

    expect(control.getSnapshot().next?.clipId).toBe('d')
    expect(live.getSnapshot().live.next?.clipId).toBe('d')
  })

  it('a steering message becomes the standing direction and asks again', async () => {
    const { bodies, live } = setup()
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.load).toBe('ok')
    })

    live.interpret('darker')

    await vi.waitFor(() => {
      expect(bodies.at(-1)?.direction?.text).toBe('darker')
    })
    expect(live.getSnapshot().live.direction?.source).toBe('dictionary')

    live.clearDirection()
    await vi.waitFor(() => {
      expect(bodies.at(-1)?.direction).toBeUndefined()
    })
    expect(live.getSnapshot().live.direction).toBeUndefined()
  })

  it('a failed request keeps the last candidates and leaves playback running', async () => {
    let fail = false
    const { control, live } = setup({
      fetchCandidates: async () =>
        fail ? await failing('404 Not Found') : await delayed(response(['b', 'd'])),
    })
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.load).toBe('ok')
    })

    fail = true
    live.interpret('darker')

    await vi.waitFor(() => {
      expect(live.getSnapshot().live.load).toBe('stale')
    })
    expect(live.getSnapshot().live.candidates).toHaveLength(2)
    expect(live.getSnapshot().live.error).toBe('404 Not Found')
    expect(control.getSnapshot().current.clipId).toBe('a')
    expect(control.getSnapshot().canGo).toBe(true)
  })

  it('requests again after a switch lands, with the clip that just started', async () => {
    const { bodies, control, live } = setup()
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.load).toBe('ok')
    })

    live.pickCandidate('d')
    live.chooseTransition(CUT)
    control.goNow()
    control.tick()

    await vi.waitFor(() => {
      expect(bodies.at(-1)?.currentClipId).toBe('d')
    })
    expect(live.getSnapshot().live.historyIds).toStrictEqual(['a'])
  })

  it('records the transition a landing used, for the variety rule', async () => {
    const { control, live } = setup()
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.load).toBe('ok')
    })

    live.pickCandidate('d')
    live.chooseTransition(CUT)
    control.goNow()
    control.tick()

    expect(live.getSnapshot().live.recentTransitions).toContain('cut')
  })
})

describe('createLive with a track and an armed switch', () => {
  const cutStep = (clipId: string) => ({ bars: 4, clipId, transition: CUT })
  const ids = ['a', 'one', 'two', 'x', 'y', 'z']

  const setup = (answers: (body: CandidateRequest) => CandidateResponse) => {
    let clock = 0
    const control = createControl(() => {}, {
      clips: ids.map((id) => playable(id)),
      now: () => clock,
      startClipId: 'a',
    })
    const bodies: CandidateRequest[] = []
    const live = createLive({
      control,
      fetchCandidates: async (body) => {
        bodies.push(body)
        return await delayed(answers(body))
      },
      fetchClipById: async (id) => await delayed(clip(id)),
      fetchLibrarySummaries: async () => await delayed([]),
    })
    const advance = (to: number) => {
      clock = to
      control.tick()
    }
    return { advance, bodies, control, live }
  }

  const trackOf = (clipIds: readonly string[]) => ({
    defaultTransition: FADE,
    id: 'track-1',
    mode: 'noncommercial' as const,
    steps: clipIds.map((id) => cutStep(id)),
    title: 'Set',
  })

  it('stages the track’s next item first, and a candidate click replaces it without leaving the track', async () => {
    const { advance, control, live } = setup(() => response(['x', 'y', 'z']))
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.load).toBe('ok')
    })
    control.loadTrack({ clips: [], id: 'track-1', steps: trackOf(['one', 'two']).steps, title: 'Set' })
    live.setTrack(trackOf(['one', 'two']))
    expect(live.getSnapshot().live.next).toMatchObject({ clipId: 'one', source: 'track' })

    live.pickCandidate('y')
    live.chooseTransition(CUT)
    expect(control.getSnapshot().next?.clipId).toBe('y')
    advance(500)
    control.goNow()
    advance(501)
    expect(control.getSnapshot().current.clipId).toBe('y')
    expect(control.getSnapshot().track).toMatchObject({ index: 0 })
  })

  it('falls back to candidate #1 once the track has no next item, without moving the track cursor', async () => {
    const { advance, control, live } = setup(() => response(['x', 'y', 'z']))
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.load).toBe('ok')
    })
    control.loadTrack({ clips: [], id: 'track-1', steps: trackOf(['one']).steps, title: 'Set' })
    live.setTrack(trackOf(['one']))
    advance(10)
    control.goNow()
    advance(11)
    expect(control.getSnapshot().current.clipId).toBe('one')

    await vi.waitFor(() => {
      expect(live.getSnapshot().live.next).toMatchObject({ clipId: 'x', source: 'candidate' })
    })
    expect(control.getSnapshot().next?.clipId).toBe('x')
    expect(control.getSnapshot().track).toMatchObject({ index: 0, queued: 0 })
  })

  it('does not swap the clip that is about to go live when a late answer arrives after Go', async () => {
    let call = 0
    const { advance, control, live } = setup((body) => {
      call += 1
      return body.currentClipId === 'a' && call > 1 ? response(['z', 'y']) : response(['x', 'y'])
    })
    await vi.waitFor(() => {
      expect(control.getSnapshot().next?.clipId).toBe('x')
    })

    advance(10)
    control.go()
    expect(control.getSnapshot().armed).toBe(true)

    live.interpret('different')
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.candidates[0]?.clipId).toBe('z')
    })

    expect(control.getSnapshot().next?.clipId).toBe('x')
  })

  it('keeps the track going when Go now finishes a fade: the step that landed is not staged again', async () => {
    const { advance, control, live } = setup(() => response(['x', 'y', 'z']))
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.load).toBe('ok')
    })
    const fadeSteps = ['one', 'two', 'x'].map((clipId) => ({ bars: 4, clipId, transition: FADE }))
    control.loadTrack({ clips: [], id: 'track-1', steps: fadeSteps, title: 'Set' })
    live.setTrack({ ...trackOf([]), steps: fadeSteps })
    advance(500)
    control.go()
    advance(2000)
    advance(3000)
    expect(control.getSnapshot().fading).toBe(true)

    control.goNow()

    expect(control.getSnapshot()).toMatchObject({
      current: { clipId: 'one' },
      next: { clipId: 'two' },
      track: { index: 0, queued: 1 },
    })
    expect(live.getSnapshot().live.next).toMatchObject({ clipId: 'two', source: 'track' })
  })

  it('does not offer a candidate whose code could not be fetched', async () => {
    const control = createControl(() => {}, {
      clips: ids.map((id) => playable(id)),
      startClipId: 'a',
    })
    const live = createLive({
      control,
      fetchCandidates: async () => await delayed(response(['x', 'broken', 'y'])),
      fetchClipById: async (id) => (id === 'broken' ? await failing('404') : await delayed(clip(id))),
      fetchLibrarySummaries: async () => await delayed([]),
    })
    const consoleError = vi.spyOn(console, 'error').mockReturnValue()

    await vi.waitFor(() => {
      expect(live.getSnapshot().live.load).toBe('ok')
    })

    expect(live.getSnapshot().live.candidates.map((entry) => entry.clipId)).toStrictEqual(['x', 'y'])
    consoleError.mockRestore()
  })
})

describe('history', () => {
  it('keeps the most recent clip last', () => {
    const state = pushHistory(pushHistory(initialLive(), 'a'), 'b')
    expect(state.historyIds).toStrictEqual(['a', 'b'])
  })
})
