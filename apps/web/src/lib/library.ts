// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Clip, ClipEnergy, ClipSummary, EngineKind } from '@vev/shared'
import { clipSchema, clipSummarySchema } from '@vev/shared'
import * as v from 'valibot'

/**
 * The library screen's logic, kept out of `.svelte` because `.svelte` is outside the type and lint
 * gate (ADR 0001): building a query string and deciding what a clip's state looks like are both
 * decisions, and a decision made inside a template is a decision nothing checks.
 */

const CLIPS_ENDPOINT = '/api/clips'

/** How a licence filter narrows the grid. `unknown` is its own case because §14.2 makes it a recorded gap worth finding, not just another licence string. */
export type LicenceFilter = 'any' | 'commercial-ok' | 'unknown'

export interface LibraryFilters {
  /** Exact annotated energy, 1 (calm) to 5 (intense). A clip that has not been annotated has no energy and is excluded while this is set. */
  readonly energy?: ClipEnergy
  readonly engine?: EngineKind
  readonly licence?: LicenceFilter
  readonly reviewed?: boolean
  readonly tag?: string
}

/**
 * The query string for the filters `GET /api/clips` implements — `engine`, `tag` and `reviewed`
 * and nothing else.
 *
 * The split between this and `filterClips` is not arbitrary: the route supports exactly these
 * three (an absent parameter means no filter, a present-but-unparseable one is a 400 — see
 * `apps/api/src/routes/clips.ts`), and inventing a fourth parameter the server would ignore is how
 * `?energy=3` ends up quietly returning the whole library. Energy and licence are therefore
 * narrowed in the browser, over `ClipSummary`, which already carries `energy`, `license` and
 * `commercialOk`. When the route grows those filters, they move up here and `filterClips` shrinks.
 */
export const libraryQuery = (filters: LibraryFilters): string => {
  const params = new URLSearchParams()
  if (filters.engine !== undefined) {
    params.set('engine', filters.engine)
  }
  if (filters.tag !== undefined && filters.tag !== '') {
    params.set('tag', filters.tag)
  }
  if (filters.reviewed !== undefined) {
    params.set('reviewed', String(filters.reviewed))
  }

  const query = params.toString()
  return query === '' ? '' : `?${query}`
}

/** Applies the filters the server does not implement. See `libraryQuery` for why this half exists. */
export const filterClips = (clips: readonly ClipSummary[], filters: LibraryFilters): readonly ClipSummary[] =>
  clips.filter((clip) => {
    if (filters.energy !== undefined && clip.energy !== filters.energy) {
      return false
    }
    if (filters.licence === 'commercial-ok' && !clip.commercialOk) {
      return false
    }
    if (filters.licence === 'unknown' && clip.license !== 'unknown') {
      return false
    }

    return true
  })

const clipListSchema = v.object({ clips: v.array(clipSummarySchema) })

/**
 * Fetches the library, server-filtered where the route can and browser-filtered where it cannot.
 * A non-OK response throws with the route's own message body — `GET /api/clips` refuses a bad
 * filter value with text naming the parameter and what it accepts, and that text is more use on
 * screen than the status code is.
 */
export const fetchLibrary = async (
  filters: LibraryFilters = {},
  fetchImpl: typeof fetch = fetch,
): Promise<readonly ClipSummary[]> => {
  const endpoint = `${CLIPS_ENDPOINT}${libraryQuery(filters)}`
  const response = await fetchImpl(endpoint)
  if (!response.ok) {
    const detail = await response.text().catch(() => '')
    throw new Error(detail === '' ? `GET ${endpoint} failed with ${response.status}` : detail)
  }

  const { clips } = v.parse(clipListSchema, await response.json())
  return filterClips(clips, filters)
}

/**
 * Reads one clip in full, `code` included. The library grid deliberately never carries code
 * (`clipSummarySchema`), so this is what the control panel calls once per distinct clip in a track
 * before it can play one — see `fetchTrackClips` in `$lib/track-editor.ts`.
 */
export const fetchClip = async (id: string, fetchImpl: typeof fetch = fetch): Promise<Clip> => {
  const endpoint = `${CLIPS_ENDPOINT}/${id}`
  const response = await fetchImpl(endpoint)
  if (!response.ok) {
    // The route's own text, exactly as `fetchLibrary` above does with it — a status code alone
    // tells the panel's user nothing about which clip a track could not load.
    const detail = await response.text().catch(() => '')
    throw new Error(detail === '' ? `GET ${endpoint} failed with ${response.status}` : detail)
  }

  return v.parse(clipSchema, await response.json())
}

/**
 * What a flag asks of the person looking at the grid.
 *
 * - `attention` — something is wrong and a human has to act: the annotation failed, or the licence
 *   is a recorded gap (§14.2).
 * - `waiting` — nothing is wrong and there is nothing to do: annotation has not finished yet
 *   (§0 principle 2 — annotation never blocks registration, so "not yet" is a normal state).
 * - `info` — a fact about the clip that the grid must show, not a problem: §11's "unreviewed clips
 *   may appear as candidates, but are marked in the UI".
 *
 * The distinction between the first two is the point: a clip that needs attention and a clip that
 * needs patience must not look the same, or the performer re-runs the one and waits on the other.
 */
export type ClipFlagTone = 'attention' | 'info' | 'waiting'

export interface ClipFlag {
  /** Stable, machine-readable — what a test and a CSS class both key off. */
  readonly id: 'annotation-failed' | 'annotation-pending' | 'licence-unknown' | 'unreviewed'
  readonly label: string
  /** The longer form, for a `title` attribute: what it means and what (if anything) to do. */
  readonly detail: string
  readonly tone: ClipFlagTone
}

/** Every flag a clip carries, in the order they should be shown: what needs doing first, first. */
export const clipFlags = (clip: ClipSummary): readonly ClipFlag[] => {
  const flags: ClipFlag[] = []

  if (clip.annotationStatus === 'failed') {
    flags.push({
      detail: 'Automatic annotation failed for this clip. Re-run it, or fill the fields in by hand.',
      id: 'annotation-failed',
      label: 'Annotation failed',
      tone: 'attention',
    })
  } else if (clip.annotationStatus === 'pending') {
    flags.push({
      detail: 'Annotation has not run yet. Nothing to do — tags and energy appear once it finishes.',
      id: 'annotation-pending',
      label: 'Not yet annotated',
      tone: 'waiting',
    })
  }

  if (clip.license === 'unknown') {
    flags.push({
      detail:
        'Nobody stated a licence for this clip, so it is recorded as unknown and can never be used commercially (§14.2).',
      id: 'licence-unknown',
      label: 'Licence unknown',
      tone: 'attention',
    })
  }

  if (!clip.reviewed) {
    flags.push({
      detail: 'No human has checked this clip yet. It can still be used; it is marked so you know (§11).',
      id: 'unreviewed',
      label: 'Unreviewed',
      tone: 'info',
    })
  }

  return flags
}

/**
 * Where the browser fetches a clip's thumbnail, or `undefined` when it has none — a clip
 * registered before its recording was uploaded, or one whose upload failed.
 *
 * `/media/:key` is the public route (`apps/api/src/routes/media.ts`); the key itself is what the
 * row stores, deliberately not a URL, so no hostname is baked into the database.
 */
export const thumbnailUrl = (clip: ClipSummary): string | undefined =>
  clip.thumbnailKey === undefined ? undefined : `/media/${clip.thumbnailKey}`

/** Every tag present in a set of clips, de-duplicated and sorted — the tag filter's options. */
export const collectTags = (clips: readonly ClipSummary[]): readonly string[] =>
  [...new Set(clips.flatMap((clip) => clip.tags ?? []))].toSorted((a, b) => a.localeCompare(b))
