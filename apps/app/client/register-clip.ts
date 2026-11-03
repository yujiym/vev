// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Clock } from '@vev/engines'
import type { ProbeResult } from '@vev/engines/hydra'
import { extractLicense } from '@vev/ingest'
import type { Clip, EngineKind, NewClip, NewClipOrigin } from '@vev/shared'
import { clipSchema, newClipSchema } from '@vev/shared'
import * as v from 'valibot'

import type { Compositor } from './compositor.ts'
import { createHydraCompositor } from './compositor.ts'
import { failure } from './library.ts'
import { dominantColours, readCanvasPixelsSync, recordThumbnail } from './palette.ts'
import type { SampledFrame } from './palette.ts'
import { encodeJpeg, snapshotCanvas, stillMoments, stillSize } from './stills.ts'
import type { StillSize } from './stills.ts'

/**
 * The registration screen's own transient `HydraCompositor` (spec §11.1) is created for the
 * probe, used for the thumbnail recording, and disposed immediately — never left mounted after
 * save. §11.1 requires the probe and the thumbnail recording to run in a browser, and the stage is
 * the only browser there is, so they run beside the live picture on its GPU (ADR 0012).
 * `registrationGate` keeps them away from a switch in flight, and §6.5's cap on live WebGL contexts
 * is why "disposed immediately" matters here, not "never created".
 */

/** What a registrant fills in on the registration form — the browser-side counterpart of `@vev/shared`'s `newClipSchema`. */
export interface ClipFormInput {
  readonly author: string
  readonly code: string
  readonly commercialOk: boolean
  readonly engine: EngineKind
  readonly license: string
  readonly modified: boolean
  readonly origin: NewClipOrigin
  readonly slug?: string
  readonly sourceUrl?: string
  readonly title: string
}

/** What the registration form pre-fills from a pasted clip's header comment — the human corrects what this found. */
export interface ClipPrefill {
  readonly author: string
  readonly license: string
  readonly sourceUrl?: string
}

/**
 * Pre-fills author, licence and source-url from `code`'s header comment (`extractLicense`, spec
 * §11). An unstated licence becomes `"unknown"` here — never guessed — per spec §14.2: a licence
 * gap is a recorded fact, not something this function is allowed to invent. An unstated author is
 * left as an empty string for the registrant to fill in; unlike licence, there is no valid
 * placeholder value for "no author stated" that the schema would accept (`author` is a required,
 * non-empty field), so the human must supply one before the clip can be saved.
 */
export const prefillFromCode = (code: string): ClipPrefill => {
  const info = extractLicense(code)
  // `sourceUrl` is set to `undefined` (never omitted via a conditional spread) when the header
  // didn't state one — the same "always the key, `?? undefined` when absent" idiom the API side
  // uses for D1's nullable columns (see `apps/app/src/routes/clips.ts`'s `nullsToUndefined`);
  // `JSON.stringify` drops an `undefined`-valued key on its own when this later goes over the wire.
  return { author: info.author ?? '', license: info.license ?? 'unknown', sourceUrl: info.sourceUrl }
}

/** The prefillable subset of `ClipFormInput` — the fields `applyPrefill` can fill in. `sourceUrl` is always present (possibly `''`), unlike `ClipPrefill`'s optional one, since this is a live form field, not a detection result. */
export interface PrefillableFields {
  readonly author: string
  readonly license: string
  readonly sourceUrl: string
}

/**
 * Fills in `current`'s empty fields from `prefill`, leaving anything the registrant already typed
 * alone. This is a decision (what "already typed something" means, and that it wins over a fresh
 * probe's re-detection), so it lives here — tested — rather than inline in the page's event
 * handler, per ADR 0001: `.svelte` is outside the type and lint gate.
 */
export const applyPrefill = (current: PrefillableFields, prefill: ClipPrefill): PrefillableFields => ({
  author: current.author === '' ? prefill.author : current.author,
  license: current.license === '' ? prefill.license : current.license,
  sourceUrl:
    current.sourceUrl === '' && prefill.sourceUrl !== undefined ? prefill.sourceUrl : current.sourceUrl,
})

/**
 * Turns a filled-in form into the exact payload `POST /api/clips` accepts (`newClipSchema`).
 * Parsing through the schema client-side, not just server-side, means a registrant sees a
 * rejection (an empty title, `license: "unknown"` paired with `commercialOk: true`, ...) before a
 * round trip to the server, not instead of the server's own check — the server re-validates
 * independently and is the actual authority.
 */
export const buildNewClip = (input: ClipFormInput): NewClip =>
  v.parse(newClipSchema, {
    author: input.author,
    code: input.code,
    commercialOk: input.commercialOk,
    engine: input.engine,
    license: input.license,
    modified: input.modified,
    origin: input.origin,
    slug: input.slug,
    sourceUrl: input.sourceUrl,
    title: input.title,
  })

/**
 * The subset of `probeClip` (`@vev/engines/hydra`) the registration page needs to run the
 * validation gate. Declared here, not imported as a value from there, so this module can be
 * imported (and tested) without ever touching `hydra-synth` or `window` — see `runProbe`'s default,
 * which is the only place the real thing is reached, and only via a dynamic import, matching
 * `createHydraCompositor`.
 */
export type ProbeFn = (code: string, canvas: HTMLCanvasElement) => Promise<ProbeResult>

const defaultProbe: ProbeFn = async (code, canvas) => {
  const { probeClip } = await import('@vev/engines/hydra')
  return await probeClip(code, canvas)
}

/**
 * Runs the validation probe against a canvas the registration page owns. A thin forwarder to
 * `probeClip` by default — its entire reason to exist is to be the one place the page's dynamic
 * `import('@vev/engines/hydra')` lives, so the `.svelte` file (outside the type and lint gate, ADR
 * 0001) never has to import it directly.
 */
export const runProbe = async (
  code: string,
  canvas: HTMLCanvasElement,
  probe: ProbeFn = defaultProbe,
): Promise<ProbeResult> => await probe(code, canvas)

/** Encodes every copied frame, dropping any the browser cannot encode rather than failing the capture. */
const encodeStills = async (
  frames: readonly HTMLCanvasElement[],
  encode: (frame: HTMLCanvasElement) => Promise<Blob>,
): Promise<Blob[]> => {
  const encoded = await Promise.all(
    frames.map(async (frame) => {
      try {
        return await encode(frame)
      } catch (error) {
        console.error('captureThumbnail: could not encode a still frame', error)
        return null
      }
    }),
  )
  return encoded.filter((blob) => blob !== null)
}

/** How many milliseconds into a thumbnail recording the mid-recording palette sample is taken. */
const midRecordingFraction = (ms: number): number => ms / 2

export interface ThumbnailCapture {
  readonly blob: Blob
  readonly palette: string[]
  /** JPEG frames spread across the recording, in order. Empty when none could be taken: stills never fail a capture. */
  readonly stills: Blob[]
}

export interface CaptureThumbnailDeps {
  readonly createCompositor?: (clock: Clock) => Compositor | Promise<Compositor>
  readonly encode?: (frame: HTMLCanvasElement) => Promise<Blob>
  readonly now?: () => number
  readonly record?: (canvas: HTMLCanvasElement, ms: number) => Promise<Blob>
  readonly sample?: (canvas: HTMLCanvasElement) => SampledFrame
  readonly snapshot?: (canvas: HTMLCanvasElement, size: StillSize) => HTMLCanvasElement
}

/**
 * Records a thumbnail for an already-probed clip and derives its palette from what was actually
 * rendered (spec §11: "computed from what was actually rendered rather than guessed from code by
 * a model").
 *
 * This is the second, separate `HydraCompositor` context the registration screen ever opens — the
 * probe's own context (`probeClip`, `@vev/engines/hydra`) is already disposed by the time this
 * runs, so at most one of the two exists at once, honouring spec §6.5's cap. It is mounted, driven
 * by an ordinary `requestAnimationFrame` tick loop for the recording's duration, and disposed in a
 * `finally` so a `MediaRecorder` failure can't leave it running.
 *
 * The palette frame is sampled with `readCanvasPixelsSync` (`client/palette.ts`) from INSIDE the tick
 * callback, synchronously, right after `compositor.tick()` — not from an independently-scheduled
 * `setTimeout`. A canvas with `preserveDrawingBuffer: false` (Hydra's default) only reliably holds
 * its just-drawn pixels for a read in the same synchronous turn as the draw; a read from a separate
 * task landing between two animation frames of an ongoing recording was confirmed, manually, to
 * read back all-zero pixels even while the canvas visibly renders and the recorded WebM itself
 * contains correct frames throughout (see the M2 task 4 report).
 *
 * The stills are taken the same way, for the same reason: `snapshot` copies the canvas inside the
 * tick, at `stillMoments`, onto a small 2D canvas of a size jev accepts. Encoding to JPEG happens
 * after the recording, from those copies. Any failure in that path drops a frame, never the
 * thumbnail or the palette — stills are an enhancement to annotation, and registration must not
 * depend on them.
 */
export const captureThumbnail = async (
  code: string,
  canvas: HTMLCanvasElement,
  ms: number,
  deps: CaptureThumbnailDeps = {},
): Promise<ThumbnailCapture> => {
  const {
    createCompositor = createHydraCompositor,
    encode = encodeJpeg,
    now = Date.now,
    record = recordThumbnail,
    sample = readCanvasPixelsSync,
    snapshot = snapshotCanvas,
  } = deps

  const clock: Clock = { beatsPerBar: 4, bpm: 120, downbeatAt: now() }
  const compositor = await createCompositor(clock)
  compositor.mount(canvas)
  compositor.load('a', code)
  compositor.switchTo('a', { bars: 0, kind: 'cut' }, now())

  const midpointMs = midRecordingFraction(ms)
  const startedAt = now()
  const moments = stillMoments(ms)
  const size = stillSize(canvas.width, canvas.height)
  const snapshots: HTMLCanvasElement[] = []
  let midFrame: SampledFrame | undefined
  let frame: number | undefined
  const tick = (): void => {
    compositor.tick(now())
    const elapsed = now() - startedAt
    if (midFrame === undefined && elapsed >= midpointMs) {
      midFrame = sample(canvas)
    }
    if (size !== undefined && moments.length > 0 && elapsed >= (moments[0] ?? Infinity)) {
      // A moment is spent whether or not the copy works: retrying a failing copy every frame
      // would only repeat the failure.
      moments.shift()
      try {
        snapshots.push(snapshot(canvas, size))
      } catch (error) {
        console.error('captureThumbnail: could not copy a still frame', error)
      }
    }
    frame = requestAnimationFrame(tick)
  }
  frame = requestAnimationFrame(tick)

  try {
    const blob = await record(canvas, ms)
    return {
      blob,
      palette: midFrame === undefined ? [] : dominantColours([midFrame]),
      stills: await encodeStills(snapshots, encode),
    }
  } finally {
    if (frame !== undefined) {
      cancelAnimationFrame(frame)
    }
    compositor.dispose()
  }
}

const REGISTER_CLIP_ENDPOINT = '/api/clips'

/**
 * Registers a clip: `POST /api/clips` with `payload`, parsed back through `clipSchema` so a caller
 * gets the full server-assigned row (id, slug, computed `deps`/`isolated`) with the same shape
 * guarantees the rest of the app relies on. Browser requests reach an Access-protected origin, so
 * Access itself supplies `Cf-Access-Jwt-Assertion` — this function never sets that header; only
 * this module's own tests (which call a route directly, bypassing Access) need to.
 */
export const submitClip = async (payload: NewClip, fetchImpl: typeof fetch = fetch): Promise<Clip> => {
  const response = await fetchImpl(REGISTER_CLIP_ENDPOINT, {
    body: JSON.stringify(payload),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })

  if (!response.ok) {
    throw await failure(response, `register-clip: POST ${REGISTER_CLIP_ENDPOINT}`)
  }

  const body: unknown = await response.json()
  return v.parse(clipSchema, body)
}

const thumbnailUploadSchema = v.object({
  palette: v.optional(v.array(v.pipe(v.string(), v.minLength(1)))),
  thumbnailKey: v.pipe(v.string(), v.minLength(1)),
})

/**
 * Uploads a recorded thumbnail (`recordThumbnail`, `client/palette.ts`) for an already-registered
 * clip: `POST /api/clips/:id/thumbnail` with the WebM blob as the request body.
 *
 * The palette travels with the recording rather than with the registration payload, because it is
 * MEASURED from the frames this recording captured (`dominantColours`, spec §11) and the Worker
 * has no WebGL to measure it itself. It is evidence produced alongside the bytes, not a claim the
 * registrant makes — which is why it is not in `newClipSchema` (spec §5 lists `palette` among the
 * annotated fields, and those are absent from the registration payload by construction). A clip
 * with no thumbnail therefore has no palette, which is already true of the thumbnail itself.
 */
export const submitThumbnail = async (
  clipId: string,
  blob: Blob,
  palette: readonly string[] = [],
  fetchImpl: typeof fetch = fetch,
): Promise<{ palette?: string[]; thumbnailKey: string }> => {
  const query =
    palette.length === 0 ? '' : `?${new URLSearchParams({ palette: palette.join(',') }).toString()}`
  const endpoint = `${REGISTER_CLIP_ENDPOINT}/${clipId}/thumbnail${query}`
  const response = await fetchImpl(endpoint, {
    body: blob,
    headers: { 'content-type': blob.type === '' ? 'video/webm' : blob.type },
    method: 'POST',
  })

  if (!response.ok) {
    throw await failure(response, `register-clip: POST ${endpoint}`)
  }

  const body: unknown = await response.json()
  return v.parse(thumbnailUploadSchema, body)
}

/**
 * Uploads a clip's stills: `POST /api/clips/:id/stills` with one multipart `still` part per JPEG,
 * in recording order. Uploading is what makes annotation run again with the frames in hand (see
 * `apps/app/src/routes/stills.ts`).
 *
 * Best effort by contract: it resolves to a message saying what went wrong instead of throwing,
 * because the clip is already registered and stills only improve its annotation. `undefined` means
 * the stills were stored, or there were none to store.
 */
export const submitStills = async (
  clipId: string,
  stills: readonly Blob[],
  fetchImpl: typeof fetch = fetch,
): Promise<string | undefined> => {
  if (stills.length === 0) {
    return undefined
  }
  const form = new FormData()
  for (const [index, still] of stills.entries()) {
    form.append('still', still, `still-${index}.jpg`)
  }
  const endpoint = `${REGISTER_CLIP_ENDPOINT}/${clipId}/stills`
  try {
    const response = await fetchImpl(endpoint, { body: form, method: 'POST' })
    if (!response.ok) {
      throw await failure(response, `register-clip: POST ${endpoint}`)
    }
    return undefined
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}
