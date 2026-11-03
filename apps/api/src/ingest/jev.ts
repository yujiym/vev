// SPDX-License-Identifier: AGPL-3.0-or-later
import * as v from 'valibot'

/**
 * The ONE module that knows what `typesafe/jev` looks like on the wire.
 *
 * Nothing else in this repository may touch a raw jev request or response: callers describe
 * questions with `scoreQuestion` / `choiceQuestion` / `noulQuestion` and read back the typed
 * answers `askJev` returns.
 *
 * The envelope below is OBSERVED, not documentation: `cf ai run typesafe/jev-1.14.0` on
 * 2026-11-03 returned
 *
 *     { "model": "jev-1.14.0",
 *       "answers": { "sym": {"type":"noul","noul":0.86}, "density": {...}, "bright": {...} },
 *       "usage": { "input_tokens": 1162, "output_tokens": 69 } }
 *
 * so answers live under `answers`, one per question id, and siblings (`model`, `usage`) sit next
 * to that object and are ignored. NOT observed: how the Worker's `AI` binding wraps that result.
 * The model page shows the binding returning the object above directly, and this parser requires
 * exactly that — a top-level `answers` object, nothing else required. The `{ state, result }`
 * wrapper the CLI adds around it is deliberately not tolerated here; if the binding turns out to
 * add one, that is a one-line change in `envelopeSchema`, made on evidence.
 *
 * `typesafe/jev` resolves to 1.13; `typesafe/jev-1.14.0` is pinned so a release cannot change what
 * annotation asks or how it answers without a commit.
 *
 * Quoted from https://developers.cloudflare.com/ai/models/typesafe/jev/ (read 2026-09-29) —
 * `state` is a string or object, `questions` maps a question id to a definition, and `assets` maps
 * a key to an image the `state` refers to:
 *
 *     score:  { type: 'score',  instructions: '<question>', criteria: ['level 0 desc', 'level 1 desc', ...] }
 *     choice: { type: 'choice', instructions: '<question>', criteria: { option_key: 'desc', ... } }
 *     noul:   { type: 'noul',   instructions: '<statement>', criteria: { true: 'desc', false: 'desc' } }
 *     image:  { type: 'image',  format: 'png' | 'jpeg', data_base64: '<bytes>' }
 *
 *     score  -> { type: 'score',  score: 1.04, confidence: 0.94, legend: {...}, probabilities: {...} }
 *     choice -> { type: 'choice', choice: 'selected_key', confidence: 0.8, probabilities: {...} }
 *     noul   -> { type: 'noul',   noul: 0.95 }
 *
 * Three consequences the documentation states and this module enforces: a `score`'s criteria is an
 * ARRAY whose levels are ZERO-BASED, and the answer is a FLOAT within `0 .. criteria.length - 1`
 * (converting that to a domain value is the CALLER's job — see `annotate.ts`'s `energy`); a
 * `choice` option is a KEY with a description, so the answer must be one of the keys asked; and a
 * `noul` question is a STATEMENT with true/false criteria whose answer is a bare probability with
 * no confidence field at all.
 *
 * `confidence` is parsed as OPTIONAL on `score` and `choice`. It is documented, and the observed
 * `choice` answer carried it, but the observed `score` answer did not (it had `score`, `legend`
 * and `probabilities` only). Nothing here branches on it, so requiring it would have failed every
 * clip over a field that is only ever logged.
 */

/** Third-party model billed from prepaid AI Gateway credits, not from Workers Paid neurons. Pinned — see the header. */
const JEV_MODEL = 'typesafe/jev-1.14.0'

/**
 * The narrow slice of the `AI` binding this module (and the description call in `annotate.ts`)
 * uses. Declared structurally rather than as `Ai`, because `Ai.run` is typed
 * `<Name extends keyof AiModels>` and `typesafe/jev` — a third-party AI Gateway model — is absent
 * from that generated catalogue, so the real binding's own type cannot express this call. It
 * doubles as the tests' seam: a fake `AI` is an object with a `run`.
 */
export interface AiRunner {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters, anti-slop/no-unknown-returns -- this IS the I/O boundary the rule points at: the request is built below from typed questions and the response is decoded below by `answersSchema`, so `unknown` here is what stops an unparsed value escaping this module.
  readonly run: (model: string, inputs: unknown) => Promise<unknown>
}

/** What a caller asks. The wire spelling of each of these lives only in `toWireQuestion`. */
export type JevQuestion =
  | {
      readonly instructions: string
      readonly kind: 'choice'
      /** Option key -> description. The keys are the caller's domain enum; the answer is one of them. */
      readonly options: Readonly<Record<string, string>>
    }
  | {
      readonly instructions: string
      readonly kind: 'score'
      /** Level descriptions, lowest first. Zero-based: five levels are 0-4. */
      readonly levels: readonly string[]
    }
  | {
      readonly kind: 'noul'
      readonly statement: string
      readonly whenFalse: string
      readonly whenTrue: string
    }

/** A five-level score question. Levels are zero-based and the answer is a float across them. */
export const scoreQuestion = (instructions: string, levels: readonly string[]): JevQuestion => ({
  instructions,
  kind: 'score',
  levels,
})

/** A choice question over `options`, whose KEYS are the domain enum and whose values describe each one. */
export const choiceQuestion = (
  instructions: string,
  options: Readonly<Record<string, string>>,
): JevQuestion => ({ instructions, kind: 'choice', options })

/** A noul question: a statement, plus what makes it true and what makes it false. The answer is a probability. */
export const noulQuestion = (statement: string, whenTrue: string, whenFalse: string): JevQuestion => ({
  kind: 'noul',
  statement,
  whenFalse,
  whenTrue,
})

/** A batch of questions, keyed by an id the caller chooses; the same ids key the answers. */
export type JevQuestionSet = Readonly<Record<string, JevQuestion>>

/** A rendered still the questions may be judged against. PNG or JPEG only; TypeSafe rejects anything else. */
export interface JevImage {
  readonly bytes: Uint8Array
  readonly format: 'jpeg' | 'png'
}

/** The request's `assets` entry for one image: the wire spelling of a `JevImage`. */
interface JevWireImage {
  readonly data_base64: string
  readonly format: 'jpeg' | 'png'
  readonly type: 'image'
}

/** `btoa` takes a binary string; building it in slices keeps the argument list of `fromCharCode` bounded. */
const BASE64_SLICE = 0x80_00

const toBase64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += BASE64_SLICE) {
    binary += String.fromCodePoint(...bytes.subarray(offset, offset + BASE64_SLICE))
  }
  return btoa(binary)
}

const assetKey = (index: number): string => `still-${index}`

/**
 * With images the `state` is an object that names each asset by its key; without, it stays the
 * plain string it always was. The `assets` map is the other half of that reference.
 */
const toWireRequest = (
  state: string,
  wireQuestions: Readonly<Record<string, JevWireQuestion>>,
  assets: readonly JevImage[],
) => {
  if (assets.length === 0) {
    return { questions: wireQuestions, state }
  }
  const wireAssets: Record<string, JevWireImage> = {}
  const keys: string[] = []
  for (const [index, image] of assets.entries()) {
    const key = assetKey(index)
    keys.push(key)
    wireAssets[key] = { data_base64: toBase64(image.bytes), format: image.format, type: 'image' }
  }
  return { assets: wireAssets, questions: wireQuestions, state: { brief: state, stills: keys } }
}

/** A decoded answer, range-checked against the question that asked it. */
export type JevAnswer =
  | { readonly confidence?: number; readonly key: string; readonly kind: 'choice' }
  | { readonly confidence?: number; readonly kind: 'score'; readonly score: number }
  | { readonly kind: 'noul'; readonly probability: number }

/** The answers to a `JevQuestionSet`, under the same ids. */
export type JevAnswerSet = Readonly<Record<string, JevAnswer>>

type JevWireQuestion =
  | { readonly criteria: readonly string[]; readonly instructions: string; readonly type: 'score' }
  | {
      readonly criteria: Readonly<Record<string, string>>
      readonly instructions: string
      readonly type: 'choice'
    }
  | {
      readonly criteria: { readonly false: string; readonly true: string }
      readonly instructions: string
      readonly type: 'noul'
    }

const toWireQuestion = (question: JevQuestion): JevWireQuestion => {
  if (question.kind === 'score') {
    return { criteria: question.levels, instructions: question.instructions, type: 'score' }
  }
  if (question.kind === 'choice') {
    return { criteria: question.options, instructions: question.instructions, type: 'choice' }
  }
  return {
    criteria: { false: question.whenFalse, true: question.whenTrue },
    instructions: question.statement,
    type: 'noul',
  }
}

const confidenceSchema = v.optional(v.pipe(v.number(), v.finite()))

// `v.object` (not `v.strictObject`) on purpose: `legend` and `probabilities` come back alongside
// these and are deliberately ignored, so unknown keys must not be a rejection.
const answerSchema = v.union([
  v.object({ confidence: confidenceSchema, score: v.pipe(v.number(), v.finite()), type: v.literal('score') }),
  v.object({
    choice: v.pipe(v.string(), v.minLength(1)),
    confidence: confidenceSchema,
    type: v.literal('choice'),
  }),
  v.object({ noul: v.pipe(v.number(), v.minValue(0), v.maxValue(1)), type: v.literal('noul') }),
])

/**
 * The envelope as observed: `answers` holds one entry per asked id. `model` and `usage` beside it
 * are not declared, so `v.object` drops them; each answer is decoded separately below.
 */
const envelopeSchema = v.object({ answers: v.record(v.string(), v.unknown()) })

type WireAnswer = v.InferOutput<typeof answerSchema>

/**
 * Turns one wire answer into a `JevAnswer`, rejecting an answer whose type does not match the
 * question asked or whose value falls outside what the question defined. A `score` of 7 for a
 * five-level question and a `choice` of `"tropical"` for `static | slow | medium | fast` are both
 * malformed in the sense that matters — the model answered something the caller never offered —
 * and the caller must not store them.
 */
const decodeAnswer = (id: string, question: JevQuestion, answer: WireAnswer): JevAnswer => {
  if (question.kind === 'score') {
    if (answer.type !== 'score') {
      throw new Error(`jev: question "${id}" asked for a score and got a ${answer.type}`)
    }
    const highest = question.levels.length - 1
    if (answer.score < 0 || answer.score > highest) {
      throw new Error(`jev: question "${id}" scored ${answer.score}, outside its 0-${highest} levels`)
    }
    return { confidence: answer.confidence, kind: 'score', score: answer.score }
  }

  if (question.kind === 'choice') {
    if (answer.type !== 'choice') {
      throw new Error(`jev: question "${id}" asked for a choice and got a ${answer.type}`)
    }
    if (!Object.hasOwn(question.options, answer.choice)) {
      throw new Error(`jev: question "${id}" chose "${answer.choice}", which was not one of its options`)
    }
    return { confidence: answer.confidence, key: answer.choice, kind: 'choice' }
  }

  if (answer.type !== 'noul') {
    throw new Error(`jev: question "${id}" asked for a noul and got a ${answer.type}`)
  }
  return { kind: 'noul', probability: answer.noul }
}

/**
 * Asks jev every question in one call and returns the decoded answers, keyed by the ids asked.
 *
 * THROWS on anything that is not a complete, well-typed, in-range answer to every question — a
 * transport failure, an unparseable body, a missing answer, an answer of the wrong type, a value
 * outside the question's own range. That is deliberate: there is exactly one caller
 * (`annotateClip`), it treats every one of those identically (retry once, then mark the clip
 * `failed`), and a partial result silently missing a field is the one outcome that would write
 * half an annotation.
 */
export const askJev = async (
  ai: AiRunner,
  state: string,
  questions: JevQuestionSet,
  assets: readonly JevImage[] = [],
): Promise<JevAnswerSet> => {
  const asked = Object.entries(questions)
  const wireQuestions = Object.fromEntries(asked.map(([id, question]) => [id, toWireQuestion(question)]))

  const raw = await ai.run(JEV_MODEL, toWireRequest(state, wireQuestions, assets))
  const envelope = v.safeParse(envelopeSchema, raw)
  if (!envelope.success) {
    throw new Error('jev: response had no `answers` object keyed by question id')
  }

  const { answers } = envelope.output
  return Object.fromEntries(
    asked.map(([id, question]) => {
      const value = answers[id]
      if (value === undefined) {
        throw new Error(`jev: response had no answer for question "${id}"`)
      }
      const answer = v.safeParse(answerSchema, value)
      if (!answer.success) {
        throw new Error(
          `jev: answer to "${id}" did not parse — ${answer.issues[0]?.message ?? 'unknown issue'}`,
        )
      }
      return [id, decodeAnswer(id, question, answer.output)]
    }),
  )
}
