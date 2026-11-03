// SPDX-License-Identifier: AGPL-3.0-or-later
import type { CandidateRequest, CandidateResponse, Clip, ClipSummary, TransitionSpec } from '@vev/shared'
import { describe, expect, it, vi } from 'vitest'

import type { Control, Picture, PlayableClip } from './control.ts'
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
  recordArrival,
  selectNext,
} from './live.ts'

const QUIET_PICTURE: Picture = {
  load: () => {
    // Nothing to draw on in these tests.
  },
  switchTo: () => {
    // Same.
  },
  tick: () => {
    // Same.
  },
}

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
// SAFETY: the live screen reads only the fields below from a fetched clip (`fetchClip` has already
// parsed a real one); the rest of the record is irrelevant to every assertion here.
const clip = (id: string, title = id.toUpperCase(), usesFeedback = false): Clip =>
  ({
    annotationStatus: 'ok',
    code: 'osc().out()',
    deps: { usesFeedback },
    energy: 3,
    engine: 'hydra',
    id,
    reviewed: true,
    title,
  }) as unknown as Clip
/** A fake network call: it settles after a microtask, as a real fetch does, never synchronously. */
const delayed = async <T>(value: T): Promise<T> => {
  await Promise.resolve()
  return value
}
const failing = async (message: string): Promise<never> => {
  await Promise.resolve()
  throw new Error(message)
}
const keyOf = (value: string, extra: { panelOpen?: boolean; shiftKey?: boolean; textEntry?: boolean } = {}) =>
  keyAction(
    { key: value, shiftKey: extra.shiftKey },
    { panelOpen: extra.panelOpen ?? false, textEntry: extra.textEntry ?? false },
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

  it('keeps a chosen card on screen when a new answer no longer offers it', () => {
    const ok = pickCandidate(loaded(['b', 'c', 'd']), 'd')
    const refreshed = applyCandidates(
      beginRequest(ok, 'current'),
      ok.requestId + 1,
      response(['e', 'f', 'g']),
      new Map(),
    )

    expect(refreshed.pickedClipId).toBe('d')
    expect(refreshed.candidates.map((entry) => entry.clipId)).toStrictEqual(['e', 'f', 'd'])
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

  it('breaks a run of three identical transitions even when the response suggested the fourth', () => {
    const state = loaded(['b', 'c', 'd'], FADE)

    const repeated = selectNext(
      state,
      nextInput({ recentTransitions: ['crossfade', 'crossfade', 'crossfade'] }),
    )
    expect(repeated).toMatchObject({ candidateIndex: 0, transition: CUT, transitionFrom: 'rules' })

    const varied = selectNext(state, nextInput({ recentTransitions: ['cut', 'crossfade', 'crossfade'] }))
    expect(varied).toMatchObject({ transition: FADE, transitionFrom: 'suggested' })
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
    ['1', false, { index: 0, kind: 'choose-candidate' }],
    ['2', false, { index: 1, kind: 'choose-candidate' }],
    ['3', false, { index: 2, kind: 'choose-candidate' }],
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

  it('suspends every single-key shortcut while typing, in any panel', () => {
    for (const value of ['1', '2', '3', ' ', 'h', 'b', 'c']) {
      expect(keyOf(value, { panelOpen: true, textEntry: true })).toBeUndefined()
    }
  })

  it('keeps the shortcuts working while a panel is merely open, because the show runs behind it', () => {
    expect(keyOf('b', { panelOpen: true })).toStrictEqual({ kind: 'blackout' })
    expect(keyOf('1', { panelOpen: true })).toStrictEqual({ index: 0, kind: 'choose-candidate' })
  })

  it('leaves Space to a button focused inside a panel, and only Space', () => {
    expect(keyAction({ key: ' ' }, { inPanel: true, panelOpen: true, textEntry: false })).toBeUndefined()
    expect(keyAction({ key: 'b' }, { inPanel: true, panelOpen: true, textEntry: false })).toStrictEqual({
      kind: 'blackout',
    })
  })

  it('Esc closes an open panel before it means Freeze, wherever the focus is', () => {
    expect(keyOf('Escape', { panelOpen: true })).toStrictEqual({ kind: 'close-panel' })
    expect(keyOf('Escape', { panelOpen: true, textEntry: true })).toStrictEqual({ kind: 'close-panel' })
    expect(keyOf('Escape', { panelOpen: false })).toStrictEqual({ kind: 'freeze' })
  })

  it('Esc closes the menu before the panel, and the panel before it means Freeze', () => {
    const options = { panelOpen: true, textEntry: false }
    expect(keyAction({ key: 'Escape' }, { ...options, menuOpen: true })).toStrictEqual({ kind: 'close-menu' })
    expect(keyAction({ key: 'Escape' }, { ...options, menuOpen: true, textEntry: true })).toStrictEqual({
      kind: 'close-menu',
    })
    expect(keyAction({ key: 'Escape' }, { ...options, menuOpen: false })).toStrictEqual({
      kind: 'close-panel',
    })
    expect(
      keyAction({ key: 'Escape' }, { menuOpen: true, panelOpen: false, textEntry: false }),
    ).toStrictEqual({
      kind: 'close-menu',
    })
  })

  it('keeps every other key working with the menu open, because the show runs behind it', () => {
    expect(keyAction({ key: 'b' }, { menuOpen: true, panelOpen: false, textEntry: false })).toStrictEqual({
      kind: 'blackout',
    })
  })

  it('ignores modified keys so browser shortcuts still work', () => {
    expect(keyAction({ ctrlKey: true, key: 'b' }, { panelOpen: false, textEntry: false })).toBeUndefined()
    expect(keyAction({ key: 'b', metaKey: true }, { panelOpen: false, textEntry: false })).toBeUndefined()
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
    const control: Control = createControl(QUIET_PICTURE, {
      clips: [playable('a', 'A'), playable('b', 'B'), playable('d', 'D')],
      startClipId: 'a',
    })
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

    return { bodies, control, live }
  }

  it('requests candidates as soon as the screen opens and names them from the library', async () => {
    const { bodies, live } = setup()

    await vi.waitFor(() => {
      expect(live.getSnapshot().live.candidates).toHaveLength(2)
    })

    expect(bodies[0]).toMatchObject({ currentClipId: 'a', historyIds: [] })
    expect(live.getSnapshot().live.candidates.map((entry) => entry.title)).toStrictEqual(['B', 'D'])
  })

  it('a candidate click arms the switch for the next bar, with no Go', async () => {
    const { control, live } = setup()
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.candidates).toHaveLength(2)
    })

    live.pickCandidate('d')

    expect(control.getSnapshot().next?.clipId).toBe('d')
    expect(control.getSnapshot().armed).toBe(true)
    expect(live.getSnapshot().live.next?.clipId).toBe('d')
    expect(live.getSnapshot().live.pickedClipId).toBe('d')
  })

  it('a second click before the bar replaces the choice and keeps the bar', async () => {
    const { control, live } = setup()
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.candidates).toHaveLength(2)
    })

    live.pickCandidate('d')
    const { firingAt } = control.getSnapshot()
    live.pickCandidate('b')

    expect(control.getSnapshot().next?.clipId).toBe('b')
    expect(control.getSnapshot().firingAt).toBe(firingAt)
    expect(live.getSnapshot().live.pickedClipId).toBe('b')
  })

  it('clicking the outlined card again takes the choice back, and Next is the first candidate again', async () => {
    const { control, live } = setup()
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.candidates).toHaveLength(2)
    })

    live.pickCandidate('d')
    live.pickCandidate('d')

    expect(control.getSnapshot()).toMatchObject({ armed: false, next: { clipId: 'b' } })
    expect(live.getSnapshot().live).toMatchObject({ next: { clipId: 'b', source: 'candidate' } })
    expect(live.getSnapshot().live.pickedClipId).toBeUndefined()
  })

  it('pressing the same number key twice takes the choice back', async () => {
    const { control, live } = setup()
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.candidates).toHaveLength(2)
    })

    expect(live.key({ key: '2' }, { panelOpen: false })).toBe(true)
    expect(control.getSnapshot().armed).toBe(true)
    expect(live.key({ key: '2' }, { panelOpen: false })).toBe(true)

    expect(control.getSnapshot().armed).toBe(false)
    expect(live.getSnapshot().live.pickedClipId).toBeUndefined()
  })

  it('the 1/2/3 keys arm the card they name', async () => {
    const { control, live } = setup()
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.candidates).toHaveLength(2)
    })

    expect(live.key({ key: '2' }, { panelOpen: false })).toBe(true)

    expect(control.getSnapshot().next?.clipId).toBe('d')
    expect(control.getSnapshot().armed).toBe(true)
    expect(live.key({ key: '3' }, { panelOpen: false })).toBe(false)
  })

  it('a pick that cannot load is dropped, leaving nothing outlined', async () => {
    const errors = vi.spyOn(console, 'error').mockReturnValue()
    const control = createControl(
      {
        ...QUIET_PICTURE,
        load: (_slot, code) => {
          if (code === 'broken') {
            throw new SyntaxError('nope')
          }
        },
      },
      { clips: [playable('a', 'A'), { code: 'broken', id: 'b', title: 'B' }], startClipId: 'a' },
    )
    const live = createLive({
      control,
      fetchCandidates: async () => await delayed(response(['b'])),
      fetchClipById: async (id) => await delayed({ ...clip(id), code: 'broken' }),
      fetchLibrarySummaries: async () => await delayed([]),
    })
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.candidates).toHaveLength(1)
    })

    live.pickCandidate('b')

    expect(live.getSnapshot().live.pickedClipId).toBeUndefined()
    expect(control.getSnapshot().armed).toBe(false)
    errors.mockRestore()
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
    control.tick()
    control.tick()
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
    control.tick()
    control.tick()
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
    const control = createControl(QUIET_PICTURE, {
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
      control.tick()
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
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.candidates).toHaveLength(3)
    })

    live.pickCandidate('y')
    live.chooseTransition(CUT)
    expect(control.getSnapshot().next?.clipId).toBe('y')
    expect(control.getSnapshot().armed).toBe(true)
    advance(500)
    control.goNow()
    advance(501)
    expect(control.getSnapshot().current.clipId).toBe('y')
    expect(control.getSnapshot().track).toMatchObject({ index: 0 })
  })

  it('taking a choice back puts the track’s next item back as Next', async () => {
    const { control, live } = setup(() => response(['x', 'y', 'z']))
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.load).toBe('ok')
    })
    control.loadTrack({ clips: [], id: 'track-1', steps: trackOf(['one', 'two']).steps, title: 'Set' })
    live.setTrack(trackOf(['one', 'two']))
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.candidates).toHaveLength(3)
    })

    live.pickCandidate('y')
    expect(control.getSnapshot().next?.clipId).toBe('y')
    live.pickCandidate('y')

    expect(control.getSnapshot()).toMatchObject({ armed: false, next: { clipId: 'one' } })
    expect(live.getSnapshot().live.next).toMatchObject({ clipId: 'one', source: 'track' })
    expect(live.getSnapshot().live.pickedClipId).toBeUndefined()
  })

  it('a track step that will not compile is compiled once across sixty frames, not on every notification', async () => {
    const errors = vi.spyOn(console, 'error').mockReturnValue()
    let clock = 0
    let attempts = 0
    const control = createControl(
      {
        ...QUIET_PICTURE,
        load: (_slot, code) => {
          if (code === 'broken()') {
            attempts += 1
            throw new SyntaxError('nope')
          }
        },
      },
      {
        clips: [playable('a'), { code: 'broken()', id: 'bad', title: 'Bad' }],
        now: () => clock,
        startClipId: 'a',
      },
    )
    const live = createLive({
      control,
      fetchCandidates: async () => await delayed(response(['x'])),
      fetchClipById: async (id) => await delayed(clip(id)),
      fetchLibrarySummaries: async () => await delayed([]),
    })
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.load).toBe('ok')
    })

    control.loadTrack({ clips: [], id: 'track-1', steps: [cutStep('bad')], title: 'Set' })
    live.setTrack(trackOf(['bad']))
    for (let frame = 1; frame <= 60; frame += 1) {
      clock = frame * 17
      control.tick()
    }

    expect(attempts).toBe(1)
    expect(control.getSnapshot()).toMatchObject({ current: { clipId: 'a' }, next: undefined })
    expect(control.getSnapshot().pictureFault).toContain('Bad did not load')
    errors.mockRestore()
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

  it('records a cut for Back, and keeps the clip it left in the play log beside it', async () => {
    const { advance, control, live } = setup(() => response(['x', 'y', 'z']))
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.load).toBe('ok')
    })
    live.pickCandidate('x')
    live.chooseTransition(FADE)
    advance(500)
    advance(2000)
    advance(6000)
    expect(control.getSnapshot().current.clipId).toBe('x')
    expect(live.getSnapshot().live).toMatchObject({ historyIds: ['a'], recentTransitions: ['crossfade'] })

    control.back()

    expect(control.getSnapshot().current.clipId).toBe('a')
    expect(live.getSnapshot().live).toMatchObject({
      historyIds: ['a', 'x'],
      recentTransitions: ['crossfade', 'cut'],
    })
  })

  it('cuts to a feedback clip the response ranked second, as spec 9.2 requires', async () => {
    const control = createControl(QUIET_PICTURE, {
      clips: [playable('a')],
      startClipId: 'a',
    })
    const live = createLive({
      control,
      fetchCandidates: async () => await delayed(response(['lead', 'plain', 'feedback'])),
      fetchClipById: async (id) => await delayed(clip(id, id, id === 'feedback')),
      fetchLibrarySummaries: async () => await delayed([summary('a', 'A')]),
    })
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.load).toBe('ok')
    })

    live.pickCandidate('plain')
    expect(live.getSnapshot().live.next?.transition).toStrictEqual({ bars: 1, kind: 'crossfade' })
    live.pickCandidate('feedback')

    expect(live.getSnapshot().live.next).toMatchObject({ clipId: 'feedback', transition: CUT })
  })

  it('names the clip that is armed as Next when a late answer prefers another', async () => {
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

    live.interpret('different')
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.candidates[0]?.clipId).toBe('z')
    })

    expect(control.getSnapshot().next?.clipId).toBe('x')
    expect(live.getSnapshot().live.next).toMatchObject({ clipId: 'x', title: 'X' })
    expect(live.getSnapshot().live.next?.transition).toStrictEqual(control.getSnapshot().transition)
  })

  it('holds a candidate click during a fade, and arms it with a fresh transition when the fade lands', async () => {
    const { advance, control, live } = setup(() => response(['x', 'y', 'z']))
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.load).toBe('ok')
    })
    live.pickCandidate('x')
    live.chooseTransition(FADE)
    advance(500)
    advance(2000)
    expect(control.getSnapshot().fading).toBe(true)

    live.pickCandidate('y')
    live.chooseTransition(CUT)

    expect(live.getSnapshot()).toMatchObject({
      control: { chosenClipId: 'y', next: { clipId: 'x' }, transition: FADE },
      live: { next: { clipId: 'x', transition: FADE }, pickedClipId: 'y' },
    })

    advance(6000)
    expect(live.getSnapshot()).toMatchObject({
      control: { armed: true, current: { clipId: 'x' }, firingAt: 8000, next: { clipId: 'y' } },
      live: { pickedClipId: 'y' },
    })

    advance(8000)
    advance(20_000)
    expect(live.getSnapshot()).toMatchObject({
      control: { current: { clipId: 'y' } },
      live: { pickedClipId: undefined },
    })
  })

  it('keeps the chosen card through the fresh answer a landing asks for', async () => {
    const { advance, control, live } = setup((body) =>
      body.currentClipId === 'x' ? response(['one', 'two', 'z']) : response(['x', 'y', 'z']),
    )
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.load).toBe('ok')
    })
    live.pickCandidate('x')
    live.chooseTransition(FADE)
    advance(500)
    advance(2000)
    live.pickCandidate('y')
    advance(6000)

    await vi.waitFor(() => {
      expect(live.getSnapshot().live.candidates.map((entry) => entry.clipId)).toStrictEqual([
        'one',
        'two',
        'y',
      ])
    })
    expect(control.getSnapshot().next?.clipId).toBe('y')
  })

  it('a chosen candidate takes the place of the track’s next item, during a fade as well', async () => {
    const { advance, control, live } = setup(() => response(['x', 'y', 'z']))
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.load).toBe('ok')
    })
    const steps = ['one', 'two', 'a'].map((clipId) => ({ bars: 4, clipId, transition: FADE }))
    control.loadTrack({ clips: [], id: 'track-1', steps, title: 'Set' })
    live.setTrack({ ...trackOf([]), steps })
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.candidates).toHaveLength(3)
    })
    advance(10)
    control.go()
    advance(2000)
    expect(control.getSnapshot().fading).toBe(true)

    live.pickCandidate('y')
    advance(6000)
    expect(control.getSnapshot()).toMatchObject({
      current: { clipId: 'one' },
      next: { clipId: 'y' },
      track: { index: 0, queued: 1 },
    })

    advance(8000)
    advance(12_000)
    expect(control.getSnapshot()).toMatchObject({ current: { clipId: 'y' }, track: { index: 1, queued: 2 } })
    expect(control.getSnapshot().next?.clipId).toBe('a')
  })

  it('drops ordinary candidates and in-flight answers when a commercial track is loaded (§14.2)', async () => {
    const control = createControl(QUIET_PICTURE, { clips: ids.map((id) => playable(id)), startClipId: 'a' })
    const bodies: CandidateRequest[] = []
    const held = Promise.withResolvers<CandidateResponse>()
    const live = createLive({
      control,
      fetchCandidates: async (body) => {
        bodies.push(body)
        if (bodies.length === 2) {
          return await held.promise
        }
        return await delayed(bodies.length === 1 ? response(['x', 'y']) : response(['z']))
      },
      fetchClipById: async (id) => await delayed(clip(id)),
      fetchLibrarySummaries: async () => await delayed([]),
    })
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.candidates).toHaveLength(2)
    })
    live.interpret('darker')
    await vi.waitFor(() => {
      expect(bodies).toHaveLength(2)
    })

    const commercial = { ...trackOf(['one']), mode: 'commercial' as const }
    control.loadTrack({ clips: [], id: 'track-1', steps: commercial.steps, title: 'Set' })
    live.setTrack(commercial)
    expect(live.getSnapshot().live.candidates).toStrictEqual([])
    await vi.waitFor(() => {
      expect(live.getSnapshot().live.candidates.map((entry) => entry.clipId)).toStrictEqual(['z'])
    })

    held.resolve(response(['x', 'y']))
    await delayed(0)
    live.pickCandidate('x')

    expect(bodies.at(-1)).toMatchObject({ commercial: true, trackId: 'track-1' })
    expect(live.getSnapshot().live.candidates.map((entry) => entry.clipId)).toStrictEqual(['z'])
    expect(control.getSnapshot().next?.clipId).toBe('one')
  })

  it('does not offer a candidate whose code could not be fetched', async () => {
    const control = createControl(QUIET_PICTURE, {
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

describe(recordArrival, () => {
  it('records the clip that was left and the transition that replaced it together, most recent last', () => {
    const state = recordArrival(recordArrival(initialLive(), 'a', 'crossfade'), 'b', 'cut')
    expect(state.historyIds).toStrictEqual(['a', 'b'])
    expect(state.recentTransitions).toStrictEqual(['crossfade', 'cut'])
  })
})
