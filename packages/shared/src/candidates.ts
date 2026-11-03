// SPDX-License-Identifier: AGPL-3.0-or-later
import * as v from 'valibot'

import { annotationStatusSchema, clipEnergySchema, engineKindSchema } from './clip.ts'
import { transitionSpecSchema } from './playback-types.ts'

const nonEmptyString = v.pipe(v.string(), v.minLength(1))

/**
 * The default decision provider (spec §8.4): `typesafe/jev` through the Worker's `AI` binding.
 * It travels in `CandidateResult.providerId`, so it is wire vocabulary and lives here.
 */
export const DEFAULT_PROVIDER_ID = 'cf-jev'

/**
 * A clip as the candidate pipeline reads it: enough to filter and rank, and nothing that needs the
 * clip's code. `energy` and `tags` are absent until annotation has succeeded (spec §5, §11.1), so
 * every consumer must rank a clip it knows almost nothing about.
 */
export const candidateClipSchema = v.object({
  annotationStatus: annotationStatusSchema,
  commercialOk: v.boolean(),
  description: v.optional(v.string()),
  energy: v.optional(clipEnergySchema),
  engine: engineKindSchema,
  id: nonEmptyString,
  tags: v.optional(v.array(nonEmptyString)),
  /** From `deps`, which is detected at registration: true even for a clip annotation never ran on. */
  usesFeedback: v.boolean(),
})

/** A steering-chat direction (spec §8.6): a standing instruction, not a command. */
export const directionSchema = v.object({
  at: v.pipe(v.number(), v.finite()),
  avoidTags: v.optional(v.array(nonEmptyString)),
  energyTarget: v.optional(clipEnergySchema),
  energyTrend: v.optional(v.picklist(['rise', 'hold', 'fall'])),
  engine: v.optional(engineKindSchema),
  palette: v.optional(v.array(nonEmptyString)),
  source: v.picklist(['dictionary', 'llm', 'manual']),
  tags: v.optional(v.array(nonEmptyString)),
  text: v.string(),
  ttlBars: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
})

/**
 * One suggested next clip (spec §5 `CandidateResult`).
 *
 * `score` is a ranking weight from whatever produced it, never a threshold (§8.3): a `fallback`
 * score is rule-generated and a `decision` one is the model's confidence. `source` and
 * `providerId` say which, so the UI can show it and a log can attribute it.
 */
export const candidateResultSchema = v.object({
  clipId: nonEmptyString,
  providerId: v.optional(nonEmptyString),
  /** Short rule-generated text for the UI ("tag kaleidoscope; energy 4→5"), never model prose. */
  reason: v.optional(v.string()),
  score: v.pipe(v.number(), v.finite(), v.minValue(0), v.maxValue(1)),
  source: v.picklist(['decision', 'embedding', 'fallback']),
  /** Unused by `POST /api/candidates`, which returns one transition for the top candidate. See spec §17. */
  suggestedTransition: v.optional(transitionSpecSchema),
})

/**
 * A candidate request: the live state a screen with no audio analysis yet can state. Audio
 * features arrive with M11 and are the only part of spec §8.2's state missing here.
 */
export const candidateRequestSchema = v.strictObject({
  /** True when the track is commercial (§14.2). A commercial track forces this on. */
  commercial: v.optional(v.boolean(), false),
  currentClipId: nonEmptyString,
  direction: v.optional(directionSchema),
  /** Most recent last, as spec §8.2's `history` lists it. */
  historyIds: v.optional(v.array(nonEmptyString), () => []),
  /** How many clips the decision provider is asked to choose among; 20 is spec §8.1's K. */
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(50)), 20),
  nextSection: v.optional(v.string()),
  section: v.optional(v.string()),
  trackId: v.optional(nonEmptyString),
})

/** Three candidates plus the transition into the first one (spec §7, §8.1 step 4). */
export const candidateResponseSchema = v.object({
  candidates: v.array(candidateResultSchema),
  suggestedTransition: transitionSpecSchema,
})

/**
 * The state the decision provider is asked about (spec §8.2). `prompt` is the standing direction's
 * text, which may be Japanese; the provider contract is `state` plus questions.
 */
export const decisionStateSchema = v.object({
  candidates: v.array(candidateClipSchema),
  current: v.object({
    description: v.optional(v.string()),
    energy: v.optional(clipEnergySchema),
    engine: engineKindSchema,
    id: nonEmptyString,
  }),
  history: v.array(
    v.object({
      energy: v.optional(clipEnergySchema),
      engine: engineKindSchema,
      id: nonEmptyString,
    }),
  ),
  prompt: v.string(),
  section: v.object({
    current: v.optional(v.string()),
    next: v.optional(v.string()),
  }),
})

export type CandidateClip = v.InferOutput<typeof candidateClipSchema>
export type CandidateRequest = v.InferOutput<typeof candidateRequestSchema>
export type CandidateResponse = v.InferOutput<typeof candidateResponseSchema>
export type CandidateResult = v.InferOutput<typeof candidateResultSchema>
export type DecisionState = v.InferOutput<typeof decisionStateSchema>
export type Direction = v.InferOutput<typeof directionSchema>
