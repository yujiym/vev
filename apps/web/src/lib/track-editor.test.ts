// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Clip, Track, TrackItem } from '@vev/shared'
import { describe, expect, it } from 'vitest'

import {
  appendItem,
  buildNewTrack,
  createTrack,
  fetchTrackClips,
  moveItem,
  removeItem,
  resolveTrack,
  setSection,
  updateTrack,
} from './track-editor.ts'

const ITEMS = ['a', 'b', 'c', 'd']

describe(moveItem, () => {
  it('swaps exactly two positions when moving up', () => {
    expect(moveItem(ITEMS, 2, 'up')).toStrictEqual(['a', 'c', 'b', 'd'])
  })

  it('swaps exactly two positions when moving down', () => {
    expect(moveItem(ITEMS, 1, 'down')).toStrictEqual(['a', 'c', 'b', 'd'])
  })

  it('leaves every other position untouched', () => {
    const moved = moveItem(['a', 'b', 'c', 'd', 'e'], 3, 'up')
    expect(moved).toStrictEqual(['a', 'b', 'd', 'c', 'e'])
  })

  // The decided behaviour at the ends is a NO-OP, not a wrap — see moveItem's doc comment.
  it('moving the FIRST item up is a no-op, returning the same array', () => {
    const result = moveItem(ITEMS, 0, 'up')
    expect(result).toStrictEqual(ITEMS)
    expect(result).toBe(ITEMS)
  })

  it('moving the LAST item down is a no-op, returning the same array', () => {
    const result = moveItem(ITEMS, ITEMS.length - 1, 'down')
    expect(result).toStrictEqual(ITEMS)
    expect(result).toBe(ITEMS)
  })

  it('moving the only item in either direction is a no-op', () => {
    const single = ['only']
    expect(moveItem(single, 0, 'up')).toBe(single)
    expect(moveItem(single, 0, 'down')).toBe(single)
  })

  it('an out-of-range index is a no-op rather than a throw', () => {
    expect(moveItem(ITEMS, -1, 'down')).toBe(ITEMS)
    expect(moveItem(ITEMS, ITEMS.length, 'up')).toBe(ITEMS)
  })

  it('an empty list is a no-op', () => {
    const empty: string[] = []
    expect(moveItem(empty, 0, 'up')).toBe(empty)
  })

  it('does not mutate the input', () => {
    const original = [...ITEMS]
    moveItem(original, 1, 'down')
    expect(original).toStrictEqual(ITEMS)
  })

  it('round-trips: down then up restores the original order', () => {
    expect(moveItem(moveItem(ITEMS, 1, 'down'), 2, 'up')).toStrictEqual(ITEMS)
  })
})

describe(removeItem, () => {
  it('removes the item at the index', () => {
    expect(removeItem(ITEMS, 1)).toStrictEqual(['a', 'c', 'd'])
  })

  it('is a no-op out of range', () => {
    expect(removeItem(ITEMS, 9)).toBe(ITEMS)
  })
})

describe(appendItem, () => {
  it('appends a bare item with no overrides', () => {
    expect(appendItem([{ clipId: 'one' }], 'two')).toStrictEqual([{ clipId: 'one' }, { clipId: 'two' }])
  })
})

describe(setSection, () => {
  it('sets a label on the named item only', () => {
    const items: TrackItem[] = [{ clipId: 'one' }, { clipId: 'two' }]
    expect(setSection(items, 1, 'peak')).toStrictEqual([
      { clipId: 'one' },
      { clipId: 'two', section: 'peak' },
    ])
  })

  it('clears the label when given an empty string, rather than storing ""', () => {
    const items: TrackItem[] = [{ clipId: 'one', section: 'intro' }]
    expect(setSection(items, 0, '')).toStrictEqual([{ clipId: 'one', section: undefined }])
  })

  it('is a no-op out of range', () => {
    const items: TrackItem[] = [{ clipId: 'one' }]
    expect(setSection(items, 4, 'peak')).toBe(items)
  })
})

const draft = (overrides: Partial<Parameters<typeof buildNewTrack>[0]> = {}) => ({
  defaultTransition: { bars: 2, kind: 'crossfade' } as const,
  items: [] as readonly TrackItem[],
  mode: 'noncommercial' as const,
  title: 'Opening set',
  visibility: 'private' as const,
  ...overrides,
})

describe(buildNewTrack, () => {
  it('produces the payload the route accepts', () => {
    expect(buildNewTrack(draft({ items: [{ clipId: 'one' }] }))).toStrictEqual({
      // `bpmDefault` stays an explicitly-absent key rather than being omitted: `JSON.stringify`
      // drops it on the way out, and `newTrackSchema` treats `undefined` as absent on the way in.
      bpmDefault: undefined,
      defaultTransition: { bars: 2, kind: 'crossfade' },
      items: [{ clipId: 'one' }],
      mode: 'noncommercial',
      title: 'Opening set',
      visibility: 'private',
    })
  })

  it('refuses an empty title before any round trip', () => {
    expect(() => buildNewTrack(draft({ title: '' }))).toThrow(/Invalid length/u)
  })
})

const jsonResponse = (body: unknown, status = 200): Response => Response.json(body, { status })

const storedTrack = (overrides: Partial<Track> = {}): Track => ({
  defaultTransition: { bars: 2, kind: 'crossfade' },
  id: 'track-1',
  items: [],
  mode: 'noncommercial',
  ownerId: 'owner',
  slug: 'opening-set-track1',
  title: 'Opening set',
  visibility: 'private',
  ...overrides,
})

describe(createTrack, () => {
  it('POSTs the payload and parses the stored track back', async () => {
    const calls: { body: unknown; url: string }[] = []
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ body: init?.body, url: input as string })
      return await Promise.resolve(jsonResponse(storedTrack({ items: [{ clipId: 'one' }] }), 201))
    }

    const track = await createTrack(draft({ items: [{ clipId: 'one' }] }), fetchImpl)

    expect(calls[0].url).toBe('/api/tracks')
    expect(track.ownerId).toBe('owner')
  })

  it('surfaces the route’s own refusal text, which is what names the offending clip (§14.2)', async () => {
    const refusal =
      'item 0 is "Noncommercial only" (clip-9), which is not cleared for commercial use; this track\'s mode is "commercial" (§14.2)'
    const fetchImpl: typeof fetch = async () => await Promise.resolve(new Response(refusal, { status: 400 }))

    await expect(createTrack(draft(), fetchImpl)).rejects.toThrow('Noncommercial only')
  })
})

describe(updateTrack, () => {
  it('PATCHes only the fields the caller named', async () => {
    let sent = ''
    const fetchImpl: typeof fetch = async (_input, init) => {
      sent = init?.body as string
      return await Promise.resolve(jsonResponse(storedTrack({ title: 'Renamed' })))
    }

    await updateTrack('track-1', { title: 'Renamed' }, fetchImpl)

    expect(JSON.parse(sent)).toStrictEqual({ title: 'Renamed' })
  })
})

const storedClip = (overrides: Partial<Clip> = {}): Clip => ({
  annotationStatus: 'ok',
  author: 'Khoparzi',
  code: 'osc(10).out()',
  commercialOk: false,
  defaultBars: 8,
  deps: {
    extensions: [],
    outputsUsed: [],
    sourcesUsed: [],
    usesAudio: false,
    usesFeedback: false,
  },
  engine: 'hydra',
  id: 'clip-1',
  isolated: false,
  license: 'CC BY 4.0',
  modified: false,
  origin: 'imported',
  originalCode: 'osc(10).out()',
  params: [],
  reviewed: true,
  slug: 'hydra/clip-1',
  title: 'Clip one',
  ...overrides,
})

describe(resolveTrack, () => {
  it('falls back to the clip’s defaultBars and the track’s defaultTransition (§5)', () => {
    const clips = new Map([['clip-1', storedClip({ defaultBars: 16 })]])
    const track = storedTrack({ items: [{ clipId: 'clip-1' }] })

    expect(resolveTrack(track, clips).steps).toStrictEqual([
      { bars: 16, clipId: 'clip-1', transition: { bars: 2, kind: 'crossfade' } },
    ])
  })

  it('prefers the item’s own bars and transitionIn over both defaults', () => {
    const clips = new Map([['clip-1', storedClip({ defaultBars: 16 })]])
    const track = storedTrack({
      items: [{ bars: 3, clipId: 'clip-1', transitionIn: { bars: 0, kind: 'cut' } }],
    })

    expect(resolveTrack(track, clips).steps).toStrictEqual([
      { bars: 3, clipId: 'clip-1', transition: { bars: 0, kind: 'cut' } },
    ])
  })

  it('carries each clip’s code through, since a track row holds only ids', () => {
    const clips = new Map([['clip-1', storedClip({ code: 'noise(4).out()' })]])
    const track = storedTrack({ items: [{ clipId: 'clip-1' }] })

    expect(resolveTrack(track, clips).clips).toStrictEqual([
      { code: 'noise(4).out()', id: 'clip-1', title: 'Clip one' },
    ])
  })

  it('throws naming the clip when one could not be loaded, rather than silently shortening the track', () => {
    const track = storedTrack({ items: [{ clipId: 'clip-gone' }] })

    expect(() => resolveTrack(track, new Map())).toThrow('clip-gone')
  })
})

describe(fetchTrackClips, () => {
  it('fetches each distinct clip exactly once, however often it appears', async () => {
    const asked: string[] = []
    const track = storedTrack({
      items: [{ clipId: 'clip-1' }, { clipId: 'clip-2' }, { clipId: 'clip-1' }],
    })

    const clips = await fetchTrackClips(track, async (id) => {
      asked.push(id)
      return await Promise.resolve(storedClip({ id }))
    })

    expect(asked).toStrictEqual(['clip-1', 'clip-2'])
    expect([...clips.keys()]).toStrictEqual(['clip-1', 'clip-2'])
  })
})
