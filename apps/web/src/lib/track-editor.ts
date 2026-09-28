// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Clip, NewTrack, Track, TrackItem, TransitionSpec } from '@vev/shared'
import { newTrackSchema, trackSchema } from '@vev/shared'
import * as v from 'valibot'

import type { PlayableClip, TrackStep } from './control.ts'

/**
 * The track editor's logic, kept out of `.svelte` because `.svelte` is outside the type and lint
 * gate (ADR 0001). Everything here is either a pure list transform or a thin, typed wrapper over
 * `/api/tracks`, so the editor component is props in, markup out.
 */

export type MoveDirection = 'down' | 'up'

const TRACKS_ENDPOINT = '/api/tracks'

/**
 * Moves the item at `from` one position in `direction`, swapping it with its neighbour.
 *
 * At the ends this is a NO-OP, not a wrap: moving the first item up, or the last item down,
 * returns the SAME array reference, unchanged. A wrap would be the more surprising behaviour —
 * "up" on the first item silently teleporting it to the end of the set is an edit the performer
 * did not ask for, and one they might not notice in a long list. Returning the same reference (not
 * an equal copy) is deliberate too: a caller can test `next === items` to know nothing happened,
 * and a framework diffing on identity does no work.
 *
 * An out-of-range `from` is the same no-op rather than a throw: the editor's buttons can only
 * produce valid indices, so an invalid one means a stale render, and a stale render must not take
 * the panel down mid-set (§0).
 */
export const moveItem = <T>(items: readonly T[], from: number, direction: MoveDirection): readonly T[] => {
  const to = direction === 'up' ? from - 1 : from + 1
  if (from < 0 || from >= items.length || to < 0 || to >= items.length) {
    return items
  }

  const moved = [...items]
  const displaced = moved[to]
  moved[to] = moved[from]
  moved[from] = displaced
  return moved
}

/** Replaces the item at `index` with `item`. Out of range is a no-op, for the same reason as `moveItem`'s. */
export const replaceItem = <T>(items: readonly T[], index: number, item: T): readonly T[] => {
  if (index < 0 || index >= items.length) {
    return items
  }

  const next = [...items]
  next[index] = item
  return next
}

/** Removes the item at `index`. Out of range is a no-op, for the same reason as `moveItem`'s. */
export const removeItem = <T>(items: readonly T[], index: number): readonly T[] => {
  if (index < 0 || index >= items.length) {
    return items
  }

  return items.filter((_, position) => position !== index)
}

/**
 * Sets (or clears) an item's section label. An empty string clears it to `undefined` rather than
 * storing `""`: `section` is optional in `trackItemSchema`, and an empty label is the absence of a
 * label, not a label that happens to be blank.
 */
export const setSection = (
  items: readonly TrackItem[],
  index: number,
  section: string,
): readonly TrackItem[] => {
  const item = items[index]
  if (item === undefined) {
    return items
  }

  return replaceItem(items, index, { ...item, section: section === '' ? undefined : section })
}

/** Appends an item for `clipId` with no overrides — `bars` and `transitionIn` fall back to the clip's and the track's defaults at play time. */
export const appendItem = (items: readonly TrackItem[], clipId: string): readonly TrackItem[] => [
  ...items,
  { clipId },
]

/** What the editor form holds. The mirror of `newTrackSchema`, minus every server-owned field. */
export interface TrackDraft {
  readonly bpmDefault?: number
  readonly defaultTransition: TransitionSpec
  readonly items: readonly TrackItem[]
  readonly mode: Track['mode']
  readonly title: string
  readonly visibility: Track['visibility']
}

/**
 * Turns a draft into the exact payload `POST /api/tracks` accepts. Parsing client-side means the
 * editor rejects an empty title before a round trip — the server re-validates independently and
 * remains the authority, exactly as `buildNewClip` does for clips.
 *
 * It does NOT check the §14.2 commercial rule. That check needs each clip's `commercialOk`, which
 * only the server can read authoritatively, and duplicating it here would create a second place
 * for a licensing boundary to drift. The editor shows the server's refusal message instead.
 */
export const buildNewTrack = (draft: TrackDraft): NewTrack =>
  v.parse(newTrackSchema, {
    bpmDefault: draft.bpmDefault,
    defaultTransition: draft.defaultTransition,
    items: [...draft.items],
    mode: draft.mode,
    title: draft.title,
    visibility: draft.visibility,
  })

/**
 * The body of a non-OK response, as the error a caller can put on screen. The track routes refuse
 * with `c.text(...)`, and those messages are the whole point of the §14.2 check — a refusal that
 * reaches the performer as "400" names nothing and helps nobody.
 */
const failure = async (response: Response, what: string): Promise<Error> => {
  const detail = await response.text().catch(() => '')
  return new Error(detail === '' ? `${what} failed with ${response.status}` : detail)
}

export const createTrack = async (draft: TrackDraft, fetchImpl: typeof fetch = fetch): Promise<Track> => {
  const response = await fetchImpl(TRACKS_ENDPOINT, {
    body: JSON.stringify(buildNewTrack(draft)),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  if (!response.ok) {
    throw await failure(response, `POST ${TRACKS_ENDPOINT}`)
  }

  return v.parse(trackSchema, await response.json())
}

/** A track edit. Every field optional, matching the route's `v.partial(newTrackSchema)`. */
export type TrackPatch = Partial<TrackDraft>

export const updateTrack = async (
  id: string,
  patch: TrackPatch,
  fetchImpl: typeof fetch = fetch,
): Promise<Track> => {
  const response = await fetchImpl(`${TRACKS_ENDPOINT}/${id}`, {
    body: JSON.stringify({ ...patch, items: patch.items === undefined ? undefined : [...patch.items] }),
    headers: { 'content-type': 'application/json' },
    method: 'PATCH',
  })
  if (!response.ok) {
    throw await failure(response, `PATCH ${TRACKS_ENDPOINT}/${id}`)
  }

  return v.parse(trackSchema, await response.json())
}

export const fetchTrack = async (id: string, fetchImpl: typeof fetch = fetch): Promise<Track> => {
  const response = await fetchImpl(`${TRACKS_ENDPOINT}/${id}`)
  if (!response.ok) {
    throw await failure(response, `GET ${TRACKS_ENDPOINT}/${id}`)
  }

  return v.parse(trackSchema, await response.json())
}

const trackListSchema = v.object({ tracks: v.array(trackSchema) })

export const fetchTracks = async (fetchImpl: typeof fetch = fetch): Promise<Track[]> => {
  const response = await fetchImpl(TRACKS_ENDPOINT)
  if (!response.ok) {
    throw await failure(response, `GET ${TRACKS_ENDPOINT}`)
  }

  return v.parse(trackListSchema, await response.json()).tracks
}

/** A track with every clip it needs already fetched, ready to hand to `Control.loadTrack`. */
export interface ResolvedTrack {
  readonly clips: readonly PlayableClip[]
  readonly id: string
  readonly steps: readonly TrackStep[]
  readonly title: string
}

/**
 * Resolves a saved track into what the control panel can actually play: each item's code, the
 * number of bars it holds the screen for, and the transition that brings it in.
 *
 * The two fallbacks are spec §5's, applied here rather than anywhere downstream so there is one
 * place they live: `TrackItem.bars` "defaults to clip.defaultBars", and `transitionIn` is the
 * track's `defaultTransition` when the item states none.
 *
 * A missing clip throws, naming it. The API refuses to store an item pointing at a clip that does
 * not exist, so reaching this with one means a clip was deleted out from under a saved track —
 * silently dropping the item would leave a track that plays shorter than it reads, which is worse
 * on stage than a message before the set starts.
 */
export const resolveTrack = (track: Track, clips: ReadonlyMap<string, Clip>): ResolvedTrack => {
  const playable: PlayableClip[] = []
  const steps: TrackStep[] = []

  for (const item of track.items) {
    const clip = clips.get(item.clipId)
    if (clip === undefined) {
      throw new Error(`track "${track.title}" references clip "${item.clipId}", which could not be loaded`)
    }

    playable.push({ code: clip.code, id: clip.id, title: clip.title })
    steps.push({
      bars: item.bars ?? clip.defaultBars,
      clipId: clip.id,
      transition: item.transitionIn ?? track.defaultTransition,
    })
  }

  return { clips: playable, id: track.id, steps, title: track.title }
}

/**
 * Fetches every clip a track references, once each, in parallel. `GET /api/tracks/:id` carries ids
 * — never code — so the panel has to gather the code itself; `clipSummarySchema` does not carry it
 * either, by design (a library grid must not ship every clip's source).
 */
export const fetchTrackClips = async (
  track: Track,
  fetchClip: (id: string) => Promise<Clip>,
): Promise<Map<string, Clip>> => {
  const ids = [...new Set(track.items.map((item) => item.clipId))]
  const clips = await Promise.all(ids.map(async (id) => await fetchClip(id)))
  return new Map(clips.map((clip) => [clip.id, clip]))
}
