// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ClipSummary } from '@vev/shared'
import { describe, expect, it } from 'vitest'

import {
  clipFlags,
  collectTags,
  fetchClip,
  fetchLibrary,
  filterClips,
  libraryQuery,
  thumbnailUrl,
} from './library.ts'

const summary = (overrides: Partial<ClipSummary> = {}): ClipSummary => ({
  annotationStatus: 'ok',
  commercialOk: false,
  engine: 'hydra',
  id: 'clip-1',
  license: 'CC BY 4.0',
  reviewed: true,
  slug: 'hydra/clip-1',
  title: 'Clip one',
  ...overrides,
})

describe(libraryQuery, () => {
  it('is empty when nothing is filtered — an absent parameter means no filter', () => {
    expect(libraryQuery({})).toBe('')
  })

  it('carries the three filters the route implements', () => {
    expect(libraryQuery({ engine: 'textmode', reviewed: false, tag: 'glitch' })).toBe(
      '?engine=textmode&tag=glitch&reviewed=false',
    )
  })

  it('never sends energy or licence, which the route would ignore', () => {
    expect(libraryQuery({ energy: 3, licence: 'unknown' })).toBe('')
  })

  it('treats an empty tag as no tag filter rather than as a tag that is the empty string', () => {
    expect(libraryQuery({ tag: '' })).toBe('')
  })
})

describe(filterClips, () => {
  const clips = [
    summary({ commercialOk: true, energy: 1, id: 'calm', license: 'CC0 1.0' }),
    summary({ energy: 5, id: 'intense', license: 'unknown' }),
    summary({ id: 'unannotated' }),
  ]

  it('passes everything through when nothing is filtered', () => {
    expect(filterClips(clips, {})).toHaveLength(3)
  })

  it('narrows to an exact energy', () => {
    expect(filterClips(clips, { energy: 5 }).map((clip) => clip.id)).toStrictEqual(['intense'])
  })

  it('excludes a clip with no energy at all while an energy filter is set', () => {
    expect(filterClips(clips, { energy: 1 }).map((clip) => clip.id)).toStrictEqual(['calm'])
  })

  it('narrows to clips cleared for commercial use', () => {
    expect(filterClips(clips, { licence: 'commercial-ok' }).map((clip) => clip.id)).toStrictEqual(['calm'])
  })

  it('narrows to the recorded licence gaps (§14.2)', () => {
    expect(filterClips(clips, { licence: 'unknown' }).map((clip) => clip.id)).toStrictEqual(['intense'])
  })

  it('"any" is not a filter', () => {
    expect(filterClips(clips, { licence: 'any' })).toHaveLength(3)
  })
})

describe(clipFlags, () => {
  it('flags nothing on a reviewed, annotated, licensed clip', () => {
    expect(clipFlags(summary())).toStrictEqual([])
  })

  it('distinguishes a failed annotation from a pending one by tone', () => {
    const [failed] = clipFlags(summary({ annotationStatus: 'failed' }))
    const [pending] = clipFlags(summary({ annotationStatus: 'pending' }))

    expect(failed.tone).toBe('attention')
    expect(pending.tone).toBe('waiting')
    expect(failed.id).not.toBe(pending.id)
  })

  it('marks an unreviewed clip, which may still be used (§11)', () => {
    const flags = clipFlags(summary({ reviewed: false }))
    expect(flags.map((flag) => flag.id)).toStrictEqual(['unreviewed'])
    expect(flags[0].tone).toBe('info')
  })

  it('marks an unknown licence as needing attention (§14.2)', () => {
    expect(clipFlags(summary({ license: 'unknown' })).map((flag) => flag.id)).toStrictEqual([
      'licence-unknown',
    ])
  })

  it('shows what needs doing before what merely needs knowing', () => {
    const flags = clipFlags(summary({ annotationStatus: 'failed', license: 'unknown', reviewed: false }))
    expect(flags.map((flag) => flag.id)).toStrictEqual(['annotation-failed', 'licence-unknown', 'unreviewed'])
  })
})

describe(thumbnailUrl, () => {
  it('points at the public media route', () => {
    expect(thumbnailUrl(summary({ thumbnailKey: 'thumbnails/clip-1.webm' }))).toBe(
      '/media/thumbnails/clip-1.webm',
    )
  })

  it('is undefined for a clip with no recording', () => {
    expect(thumbnailUrl(summary())).toBeUndefined()
  })
})

describe(collectTags, () => {
  it('de-duplicates and sorts the tags present', () => {
    expect(
      collectTags([summary({ tags: ['glitch', 'warm'] }), summary({ tags: ['warm', 'abstract'] })]),
    ).toStrictEqual(['abstract', 'glitch', 'warm'])
  })
})

/** Hoisted out of the test body: it captures nothing, so it is a fixture, not a closure. */
const refusingFetch: typeof fetch = async () =>
  await Promise.resolve(
    new Response('engine must be one of "hydra", "textmode", "isf"; got "hydraa"', { status: 400 }),
  )

describe(fetchLibrary, () => {
  it('sends the server filters and applies the browser ones to what comes back', async () => {
    const asked: string[] = []
    const fetchImpl: typeof fetch = async (input) => {
      asked.push(input as string)
      return await Promise.resolve(
        Response.json({
          clips: [summary({ energy: 2, id: 'keep' }), summary({ energy: 4, id: 'drop' })],
        }),
      )
    }

    const clips = await fetchLibrary({ energy: 2, engine: 'hydra' }, fetchImpl)

    expect(asked).toStrictEqual(['/api/clips?engine=hydra'])
    expect(clips.map((clip) => clip.id)).toStrictEqual(['keep'])
  })

  it('throws with the route’s own message when a filter value is refused', async () => {
    await expect(fetchLibrary({}, refusingFetch)).rejects.toThrow('engine must be one of')
  })
})

/** Hoisted for the same reason as `refusingFetch` above: they capture nothing. */
const missingClipFetch: typeof fetch = async () =>
  await Promise.resolve(new Response('Not Found', { status: 404 }))

const bodylessFailureFetch: typeof fetch = async () =>
  await Promise.resolve(new Response('', { status: 503 }))

describe(fetchClip, () => {
  it('throws the route’s own message, the way fetchLibrary beside it does', async () => {
    await expect(fetchClip('missing', missingClipFetch)).rejects.toThrow('Not Found')
  })

  it('falls back to the endpoint and status when the route sent no message body', async () => {
    await expect(fetchClip('missing', bodylessFailureFetch)).rejects.toThrow(
      '/api/clips/missing failed with 503',
    )
  })
})
