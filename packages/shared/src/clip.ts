// SPDX-License-Identifier: AGPL-3.0-or-later
import * as v from 'valibot'

import { transitionSpecSchema } from './playback-types.ts'

/** The three visual engines vev renders (spec §5). */
export const engineKindSchema = v.picklist(['hydra', 'textmode', 'isf'])

/** Where a clip came from: hand-written by a vev author, imported from elsewhere, or model-generated (§11.2). */
export const clipOriginSchema = v.picklist(['imported', 'authored', 'generated'])

/**
 * What a registrant may claim for `origin`. `"generated"` is the generator's to claim (§11.2), not
 * a human registration payload's — a client sending `origin: "generated"` is claiming provenance it
 * doesn't have, the same hazard as a client-supplied `id`.
 */
export const newClipOriginSchema = v.picklist(['imported', 'authored'])

/** Automatic annotation runs after registration and must never block it (§0 principle 2); its outcome lives here. */
export const annotationStatusSchema = v.picklist(['pending', 'ok', 'failed'])

/** An external source a clip's code may pull from, recorded in `deps.sourcesUsed` (spec §5). */
export const sourceReqSchema = v.picklist(['cam', 'video', 'image', 'screen'])

const nonEmptyString = v.pipe(v.string(), v.minLength(1))

/** Runtime requirements detected at ingestion (spec §5 `Clip.deps`). */
export const clipDepsSchema = v.object({
  extensions: v.array(nonEmptyString),
  outputsUsed: v.array(nonEmptyString),
  sourcesUsed: v.array(sourceReqSchema),
  usesAudio: v.boolean(),
  usesFeedback: v.boolean(),
})

const defaultClipDeps = (): v.InferOutput<typeof clipDepsSchema> => ({
  extensions: [],
  outputsUsed: [],
  sourcesUsed: [],
  usesAudio: false,
  usesFeedback: false,
})

/** Provenance for a model-generated clip (§11.2); required when `origin` is `"generated"`. */
export const clipGeneratorSchema = v.object({
  at: v.pipe(v.number(), v.finite()),
  model: nonEmptyString,
  prompt: nonEmptyString,
})

/** 1 (calm) to 5 (intense) — annotated, so optional until a clip has been through annotation. */
export const clipEnergySchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(5))

export const clipMotionSchema = v.picklist(['static', 'slow', 'medium', 'fast'])
export const clipDensitySchema = v.picklist(['sparse', 'medium', 'dense'])
export const clipLayerHintSchema = v.picklist(['bg', 'fg', 'any'])

/**
 * An SPDX id, a licence name, or `"unknown"` — never empty (§14.2). `"unknown"` is a deliberate,
 * recorded gap, not a guess, so it is a valid value even though it forces `commercialOk` to `false`
 * at the point a clip is used — enforced below by `hasSaneCommercialClaim`, not left to a comment.
 */
export const clipLicenseSchema = nonEmptyString

/**
 * An externally controllable parameter (ISF INPUTS / Hydra macros). Nothing populates this array
 * yet — ingestion doesn't detect params this milestone — so every clip's `params` is `[]` for now.
 */
export const clipParamSchema = v.unknown()

const clipFields = {
  annotationStatus: v.optional(annotationStatusSchema, 'pending'),
  author: nonEmptyString,
  code: nonEmptyString,
  commercialOk: v.optional(v.boolean(), false),
  defaultBars: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 8),
  density: v.optional(clipDensitySchema),
  deps: v.optional(clipDepsSchema, defaultClipDeps),
  derivedFrom: v.optional(v.array(nonEmptyString)),
  description: v.optional(v.string()),
  energy: v.optional(clipEnergySchema),
  engine: engineKindSchema,
  generator: v.optional(clipGeneratorSchema),
  isolated: v.optional(v.boolean(), false),
  layerHint: v.optional(clipLayerHintSchema),
  license: clipLicenseSchema,
  modified: v.optional(v.boolean(), false),
  motion: v.optional(clipMotionSchema),
  origin: v.optional(clipOriginSchema, 'imported'),
  originalCode: v.optional(nonEmptyString),
  palette: v.optional(v.array(nonEmptyString)),
  params: v.optional(v.array(clipParamSchema), () => []),
  reviewed: v.optional(v.boolean(), false),
  slug: v.optional(nonEmptyString),
  sourceUrl: v.optional(nonEmptyString),
  tags: v.optional(v.array(nonEmptyString)),
  thumbnailKey: v.optional(nonEmptyString),
  title: nonEmptyString,
}

const GENERATOR_REQUIRED_MESSAGE = 'generator is required when origin is "generated" (§11.2)'
const LICENSE_UNKNOWN_MESSAGE =
  'license "unknown" forces commercialOk to false (§14.2) — it is a recorded gap, not cleared for commercial use'

/**
 * A full clip as stored (spec §5 `Clip`), with this milestone's deviations: `thumbnailKey` (an R2
 * object key, not `thumbnailUrl` — a URL would bake a hostname into the row) and `annotationStatus`
 * (annotation's outcome, since §0 principle 2 says annotation must never block registration). The
 * annotated fields stay optional here too — a clip can be read back before annotation finishes.
 */
const clipObjectSchema = v.object({
  ...clipFields,
  // Server-set on every stored row, so a read-back clip has these for real — not merely a
  // default filled in by this same schema at parse time.
  annotationStatus: annotationStatusSchema,
  commercialOk: v.boolean(),
  defaultBars: v.pipe(v.number(), v.integer(), v.minValue(1)),
  deps: clipDepsSchema,
  id: nonEmptyString,
  isolated: v.boolean(),
  modified: v.boolean(),
  origin: clipOriginSchema,
  originalCode: nonEmptyString,
  params: v.array(clipParamSchema),
  reviewed: v.boolean(),
  slug: nonEmptyString,
})

export const clipSchema = v.pipe(
  clipObjectSchema,
  v.check(
    (input) => input.origin !== 'generated' || input.generator !== undefined,
    GENERATOR_REQUIRED_MESSAGE,
  ),
  v.check((input) => input.license !== 'unknown' || !input.commercialOk, LICENSE_UNKNOWN_MESSAGE),
)

/**
 * What a library list needs to render a grid — not a whole `Clip`. Sending full rows (code,
 * `originalCode`, `deps`, ...) to paint a grid of thumbnails is how a library page gets slow.
 */
export const clipSummarySchema = v.object({
  annotationStatus: annotationStatusSchema,
  commercialOk: v.boolean(),
  energy: v.optional(clipEnergySchema),
  engine: engineKindSchema,
  id: nonEmptyString,
  license: clipLicenseSchema,
  reviewed: v.boolean(),
  slug: nonEmptyString,
  tags: v.optional(v.array(nonEmptyString)),
  thumbnailKey: v.optional(nonEmptyString),
  title: nonEmptyString,
})

/**
 * A registration payload: only what a human registrant legitimately declares. Everything the
 * server owns instead — `id` (§11.2), `deps` and `isolated` (detected at ingestion, not asserted
 * by a client — see the M2 ingestion route brief), `reviewed`, `annotationStatus`, `thumbnailKey`,
 * `generator`, `originalCode`, and all seven annotated fields (`description`, `tags`, `palette`,
 * `energy`, `motion`, `density`, `layerHint`) — is simply absent from this schema rather than
 * present-and-overridden, so the payload is correct by construction instead of correct only if a
 * route remembers to overwrite it. `origin` is further restricted to `imported | authored`:
 * `"generated"` is the generator's claim to make, not a registration payload's.
 */
const newClipFields = {
  author: nonEmptyString,
  code: nonEmptyString,
  commercialOk: v.optional(v.boolean(), false),
  defaultBars: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 8),
  engine: engineKindSchema,
  license: clipLicenseSchema,
  modified: v.optional(v.boolean(), false),
  origin: v.optional(newClipOriginSchema, 'imported'),
  slug: v.optional(nonEmptyString),
  sourceUrl: v.optional(nonEmptyString),
  title: nonEmptyString,
}

const newClipObjectSchema = v.strictObject(newClipFields)

export const newClipSchema = v.pipe(
  newClipObjectSchema,
  v.check((input) => input.license !== 'unknown' || !input.commercialOk, LICENSE_UNKNOWN_MESSAGE),
)

/** A transition-bearing entry in a `Track` (spec §5 `TrackItem`); `transitionIn` reuses `@vev/shared`'s existing schema. */
export const trackItemSchema = v.object({
  bars: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
  clipId: nonEmptyString,
  section: v.optional(v.string()),
  transitionIn: v.optional(transitionSpecSchema),
})

const trackFields = {
  bpmDefault: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
  defaultTransition: transitionSpecSchema,
  items: v.array(trackItemSchema),
  mode: v.picklist(['noncommercial', 'commercial']),
  title: nonEmptyString,
  visibility: v.picklist(['private', 'unlisted', 'public']),
}

/** A saved sequence of clips (spec §5 `Track`). `ownerId` is a server fact (§13: vev is single-owner in M2), so it lives only here. */
export const trackSchema = v.object({
  ...trackFields,
  id: nonEmptyString,
  ownerId: nonEmptyString,
  slug: nonEmptyString,
})

/**
 * A track-creation payload. `id` is opaque and server-generated, same as `newClipSchema`.
 * `ownerId` is absent for the same reason: unlike an opaque id, it is identity, so a client that
 * could set it could create a track owned by someone else.
 */
export const newTrackSchema = v.strictObject(trackFields)

export type EngineKind = v.InferOutput<typeof engineKindSchema>
export type ClipOrigin = v.InferOutput<typeof clipOriginSchema>
export type NewClipOrigin = v.InferOutput<typeof newClipOriginSchema>
export type AnnotationStatus = v.InferOutput<typeof annotationStatusSchema>
export type SourceReq = v.InferOutput<typeof sourceReqSchema>
export type ClipDeps = v.InferOutput<typeof clipDepsSchema>
export type ClipGenerator = v.InferOutput<typeof clipGeneratorSchema>
export type ClipEnergy = v.InferOutput<typeof clipEnergySchema>
export type ClipMotion = v.InferOutput<typeof clipMotionSchema>
export type ClipDensity = v.InferOutput<typeof clipDensitySchema>
export type ClipLayerHint = v.InferOutput<typeof clipLayerHintSchema>
export type Clip = v.InferOutput<typeof clipSchema>
export type ClipSummary = v.InferOutput<typeof clipSummarySchema>
export type NewClip = v.InferOutput<typeof newClipSchema>
export type TrackItem = v.InferOutput<typeof trackItemSchema>
export type Track = v.InferOutput<typeof trackSchema>
export type NewTrack = v.InferOutput<typeof newTrackSchema>
