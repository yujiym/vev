// SPDX-License-Identifier: AGPL-3.0-or-later
import { clipDensitySchema, clipEnergySchema, clipLayerHintSchema, clipMotionSchema } from '@vev/shared'
import type { ClipDensity, ClipDeps, ClipEnergy, ClipLayerHint, ClipMotion, EngineKind } from '@vev/shared'
import * as v from 'valibot'

import type { AiRunner, JevAnswer, JevAnswerSet, JevQuestionSet } from './jev.ts'
import { askJev, choiceQuestion, noulQuestion, scoreQuestion } from './jev.ts'
import { derivedTags, TAG_THRESHOLD, TAG_VOCABULARY } from './tags.ts'

/**
 * Annotation: the step the whole project is premised on.
 *
 * Almost nothing a clip needs annotated is free text. `energy` is a score, `motion`, `density` and
 * `layerHint` are choices from a closed enum, and every tag is a yes/no judgement — so they are
 * asked as TYPED questions of `typesafe/jev` (see `jev.ts`) rather than parsed out of a generative
 * model's prose. A prose answer drifts ("kaleid" / "kaleidoscope" / "kaleidoscopic"), and a library
 * filtered on drifting text quietly stops finding things.
 *
 * Two fields are outside that shape, each for its own reason:
 *
 * - `description` is genuinely free text, so it goes to one small text model — the code-specialised
 *   `@cf/qwen/qwen2.5-coder-32b-instruct`, since the input is code. It is BEST EFFORT: if it fails
 *   the clip keeps every other annotation and `description` stays empty.
 * - `palette` is not asked of a model at all. It is computed in the browser from the frames the
 *   clip actually rendered (`dominantColours`, `apps/web/src/lib/palette.ts`) — spec §11 records
 *   that judging a clip from still frames gets it wrong — so this module never produces it and
 *   never writes it.
 */

/** Verified present in `wrangler ai models` on 2026-09-29, and verified to answer on this account. */
const DESCRIPTION_MODEL = '@cf/qwen/qwen2.5-coder-32b-instruct'

/** One initial attempt plus one retry. A third would only delay marking a clip `failed`. */
const JEV_ATTEMPTS = 2

const DESCRIPTION_MAX_TOKENS = 160

/**
 * How long either model gets to answer before the attempt is abandoned.
 *
 * These exist because a call that never resolves is the ONE failure mode that does not end in
 * `annotationStatus: 'failed'`. Without a timeout, `annotateClip` never returns, the consumer never
 * acks, the queue redelivers until `max_retries: 2` is spent, and the clip is silently dropped
 * still marked `pending` — a state nothing in the UI distinguishes from "annotation hasn't run
 * yet". Whether Workers AI caps a hung call server-side is undocumented, and a defence that rests
 * on someone else's undocumented timeout is not a defence.
 *
 * 30s for jev and 20s for the description model are chosen to be an order of magnitude longer than
 * any inference observed on this account (the `@cf/qwen` probe answered in well under a second)
 * while keeping the worst case — two attempts, each a jev call plus a description call — at about
 * 100 seconds, far inside a queue consumer's delivery budget. Nobody is waiting on this: annotation
 * is asynchronous by §11.1, so the cost of a generous timeout is latency on a failure path, and the
 * cost of a tight one is a correct answer thrown away.
 */
const JEV_TIMEOUT_MS = 30_000
const DESCRIPTION_TIMEOUT_MS = 20_000

/**
 * Rejects `work` if it has not settled within `ms`. The timer is always cleared, so a call that
 * answers in time does not keep the isolate alive waiting for a timeout that no longer matters.
 */
const withTimeout = async <T>(work: Promise<T>, ms: number, what: string): Promise<T> => {
  const expiry = Promise.withResolvers<never>()
  const timer = setTimeout(() => {
    expiry.reject(new Error(`annotate: ${what} did not answer within ${ms}ms`))
  }, ms)
  try {
    return await Promise.race([work, expiry.promise])
  } finally {
    // Both directions matter: a call that answered in time must not leave a timer pending, and a
    // timer that already fired must not leave its rejection unobserved — `Promise.race` above is
    // what observes it.
    clearTimeout(timer)
  }
}

/** Question ids. They are the keys of both the request and the response, so they are named once. */
const ENERGY_ID = 'energy'
const MOTION_ID = 'motion'
const DENSITY_ID = 'density'
const LAYER_HINT_ID = 'layerHint'
const tagQuestionId = (name: string): string => `tag:${name}`

/**
 * `energy`'s five levels, lowest first.
 *
 * jev's score levels are ZERO-BASED, so this array is levels 0-4 and the answer is a float within
 * that range — while spec §5 types `Clip.energy` as `1 | 2 | 3 | 4 | 5`, the D1 column is an
 * integer, and §16's transition rules do integer arithmetic on it ("energy +2 or more", "within
 * ±1"). `energyFromScore` below is the one place those two facts are reconciled.
 */
const ENERGY_LEVELS: readonly string[] = [
  'Still or barely moving: a calm image a viewer could rest on indefinitely.',
  'Gentle: slow drift, a slow colour change, nothing abrupt.',
  'Moderate: continuous visible movement at a comfortable pace.',
  'Busy: fast movement, strong contrast changes, several things happening at once.',
  'Overwhelming: violent, strobing or chaotic — the most intense a clip gets.',
]

/**
 * The choice options are the ENUM KEYS from `@vev/shared`'s clip schemas, each with a description
 * jev judges against. Writing the description out is what makes a choice question answerable; the
 * key is what makes the answer storable without drift. These must stay in step with
 * `clipMotionSchema` / `clipDensitySchema` / `clipLayerHintSchema` — the tests assert the exact key
 * sets, so an enum gaining a value fails here rather than silently never being chosen.
 */
const MOTION_OPTIONS: Readonly<Record<ClipMotion, string>> = {
  fast: 'Rapid movement: quick changes, fast rotation, high-frequency oscillation.',
  medium: 'Continuous movement at a moderate, danceable pace.',
  slow: 'Movement is present but gradual — a drift, a slow rotation, a slow fade.',
  static: 'Nothing moves; the output is essentially a still frame.',
}

const DENSITY_OPTIONS: Readonly<Record<ClipDensity, string>> = {
  dense: 'The frame is packed with detail, layers or repetition, with little empty space.',
  medium: 'A moderate amount of detail; the frame is neither empty nor crowded.',
  sparse: 'A few elements in mostly empty space.',
}

const LAYER_HINT_OPTIONS: Readonly<Record<ClipLayerHint, string>> = {
  any: 'Works either as a background or as a foreground layer.',
  bg: 'Belongs underneath: broad, fairly even, filling the frame without demanding attention.',
  fg: 'Belongs on top: distinct elements against large dark or empty areas, so it composites over another clip.',
}

/**
 * What annotation needs from a clip. Narrower than `Clip` on purpose — annotation reads the code,
 * not the row. `deps` is here not because a model is asked about it but because it is what a model
 * must NOT be asked about: `derivedTags` turns `usesFeedback` and `usesAudio` straight into tags.
 */
export interface AnnotatableClip {
  readonly code: string
  readonly deps: ClipDeps
  readonly engine: EngineKind
  readonly title: string
}

/** Exactly the fields annotation produces — `palette` is absent because a model never answers it. */
export interface Annotation {
  readonly density: ClipDensity
  readonly description: string
  readonly energy: ClipEnergy
  readonly layerHint: ClipLayerHint
  readonly motion: ClipMotion
  readonly tags: string[]
}

/**
 * How sure jev was of each typed answer, for the log rather than for the row.
 *
 * Nothing branches on a confidence and no column stores one — this exists so `wrangler tail` shows
 * how well the questions are actually working, which is the only way to tell "the vocabulary and
 * the option descriptions are right" from "the model is guessing" on a library nobody has
 * annotated yet. Every field is optional because `confidence` is parsed as optional (see
 * `jev.ts`), and `noul` answers carry none at all.
 */
export interface AnnotationConfidence {
  readonly density?: number
  readonly energy?: number
  readonly layerHint?: number
  readonly motion?: number
}

/**
 * Annotation's outcome. A result, not a throw and not a partial `Annotation`: annotation failing is
 * an ordinary, expected outcome (§0 principle 2 — it must never block registration), and the caller
 * has to be able to write `annotationStatus: 'failed'` and leave every other column alone.
 */
export type AnnotationResult =
  | {
      readonly annotation: Annotation
      readonly confidence: AnnotationConfidence
      readonly ok: true
    }
  | { readonly ok: false; readonly reason: string }

/** The clip, as jev sees it. Spec §11: estimate mainly from the code — a still frame misjudges motion. */
const buildState = (clip: AnnotatableClip): string =>
  [
    `A ${clip.engine} clip for a live VJ set, titled "${clip.title}".`,
    'Judge it from its source code — what it makes the renderer draw and how that changes over time.',
    '',
    clip.code,
  ].join('\n')

const buildQuestions = (): JevQuestionSet => ({
  ...Object.fromEntries(
    TAG_VOCABULARY.map((tag) => [
      tagQuestionId(tag.name),
      noulQuestion(tag.statement, tag.whenTrue, tag.whenFalse),
    ]),
  ),
  [DENSITY_ID]: choiceQuestion('How much of the frame is filled with detail?', DENSITY_OPTIONS),
  [ENERGY_ID]: scoreQuestion('How energetic is this clip to watch?', ENERGY_LEVELS),
  [LAYER_HINT_ID]: choiceQuestion(
    'Is this clip better used as a background layer, a foreground layer, or either?',
    LAYER_HINT_OPTIONS,
  ),
  [MOTION_ID]: choiceQuestion('How fast does this clip move?', MOTION_OPTIONS),
})

/**
 * jev answers a float across zero-based levels 0-4; `Clip.energy` is the integer 1-5. `jev.ts` has
 * already refused anything outside 0-4 by the time this runs, so the clamp is belt-and-braces
 * rather than the check — it exists so an arithmetic slip here cannot produce a 0 or a 6 that the
 * schema below would then reject as if the model had misbehaved.
 */
const energyFromScore = (score: number): ClipEnergy => {
  const level = Math.min(5, Math.max(1, Math.round(score) + 1))
  return v.parse(clipEnergySchema, level)
}

const requireAnswer = (answers: JevAnswerSet, id: string): JevAnswer => {
  const answer = answers[id]
  if (answer === undefined) {
    throw new Error(`annotate: no answer for "${id}"`)
  }
  return answer
}

const scoreOf = (answers: JevAnswerSet, id: string): number => {
  const answer = requireAnswer(answers, id)
  if (answer.kind !== 'score') {
    throw new Error(`annotate: "${id}" answered as ${answer.kind}, not a score`)
  }
  return answer.score
}

const choiceOf = (answers: JevAnswerSet, id: string): string => {
  const answer = requireAnswer(answers, id)
  if (answer.kind !== 'choice') {
    throw new Error(`annotate: "${id}" answered as ${answer.kind}, not a choice`)
  }
  return answer.key
}

/** The confidence jev reported, or `undefined` when it reported none. Never a decision, only a log line. */
const confidenceOf = (answers: JevAnswerSet, id: string): number | undefined => {
  const answer = requireAnswer(answers, id)
  return answer.kind === 'noul' ? undefined : answer.confidence
}

const probabilityOf = (answers: JevAnswerSet, id: string): number => {
  const answer = requireAnswer(answers, id)
  if (answer.kind !== 'noul') {
    throw new Error(`annotate: "${id}" answered as ${answer.kind}, not a noul`)
  }
  return answer.probability
}

/**
 * The tags whose probability cleared `TAG_THRESHOLD`, in vocabulary order so the stored array is
 * stable across runs.
 *
 * The comparison is STRICT: a probability exactly equal to the threshold is NOT tagged. That is a
 * decision, not an accident — the threshold names the confidence a tag must EXCEED, so the only
 * value it can describe unambiguously is one on the excluded side of it. A test pins the boundary.
 */
const tagsFrom = (answers: JevAnswerSet): string[] =>
  TAG_VOCABULARY.filter((tag) => probabilityOf(answers, tagQuestionId(tag.name)) > TAG_THRESHOLD).map(
    (tag) => tag.name,
  )

const descriptionResponseSchema = v.object({ response: v.string() })

/**
 * The one free-text field, from one small text model. Best effort by contract: every failure —
 * transport, an unparseable body, an empty answer — returns `''` rather than throwing, because a
 * clip that has its energy, motion, density, layer hint and tags is annotated, and losing all of
 * that over a missing sentence would be the wrong trade.
 */
const describeClip = async (ai: AiRunner, clip: AnnotatableClip): Promise<string> => {
  try {
    const raw = await withTimeout(
      ai.run(DESCRIPTION_MODEL, {
        max_tokens: DESCRIPTION_MAX_TOKENS,
        messages: [
          {
            content:
              'You describe generative visuals for a VJ clip library. Answer with one or two plain sentences about what appears on screen — colour, shape and movement. No code, no markdown, no preamble.',
            role: 'system',
          },
          {
            content: `Describe this ${clip.engine} clip, titled "${clip.title}":\n\n${clip.code}`,
            role: 'user',
          },
        ],
      }),
      DESCRIPTION_TIMEOUT_MS,
      'the description model',
    )
    const parsed = v.safeParse(descriptionResponseSchema, raw)
    return parsed.success ? parsed.output.response.trim() : ''
  } catch (error) {
    console.error('annotate: description model failed', error)
    return ''
  }
}

interface TypedAnswers {
  readonly annotated: Omit<Annotation, 'description'>
  readonly confidence: AnnotationConfidence
}

const askOnce = async (ai: AiRunner, clip: AnnotatableClip): Promise<TypedAnswers> => {
  const answers = await withTimeout(askJev(ai, buildState(clip), buildQuestions()), JEV_TIMEOUT_MS, 'jev')
  return {
    annotated: {
      density: v.parse(clipDensitySchema, choiceOf(answers, DENSITY_ID)),
      energy: energyFromScore(scoreOf(answers, ENERGY_ID)),
      layerHint: v.parse(clipLayerHintSchema, choiceOf(answers, LAYER_HINT_ID)),
      motion: v.parse(clipMotionSchema, choiceOf(answers, MOTION_ID)),
      // Judged tags first, then the two derived from the static dependency analysis; the two sets
      // are disjoint by construction, since `derivedTags`' names were removed from the vocabulary.
      tags: [...tagsFrom(answers), ...derivedTags(clip.deps)],
    },
    confidence: {
      density: confidenceOf(answers, DENSITY_ID),
      energy: confidenceOf(answers, ENERGY_ID),
      layerHint: confidenceOf(answers, LAYER_HINT_ID),
      motion: confidenceOf(answers, MOTION_ID),
    },
  }
}

/**
 * Annotates one clip.
 *
 * Never throws and never returns half an annotation. A malformed response, an answer outside the
 * range its own question defined, an option jev invented, or the call throwing outright (a gateway
 * refusal counts — `AiGatewayError: 2021: Insufficient AI Gateway credits` is exactly what this
 * account returns today) all take the same path: retry once, then report failure so the caller
 * marks the clip `failed` and leaves its own fields untouched.
 */
export const annotateClip = async (ai: AiRunner, clip: AnnotatableClip): Promise<AnnotationResult> => {
  let reason = 'annotate: no attempt was made'

  for (let attempt = 1; attempt <= JEV_ATTEMPTS; attempt += 1) {
    try {
      // Sequential by design: attempt 2 exists only because attempt 1 failed.
      // oxlint-disable-next-line eslint/no-await-in-loop -- a retry must not start before the attempt it retries has failed
      const { annotated, confidence } = await askOnce(ai, clip)
      // oxlint-disable-next-line eslint/no-await-in-loop -- same loop; the description is best-effort and only runs once the typed answers are in
      const description = await describeClip(ai, clip)
      return { annotation: { ...annotated, description }, confidence, ok: true }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
      console.error(`annotate: attempt ${attempt} of ${JEV_ATTEMPTS} failed`, error)
    }
  }

  return { ok: false, reason }
}
