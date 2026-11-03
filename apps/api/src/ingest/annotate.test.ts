// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ClipDeps } from '@vev/shared'
import { clipDensitySchema, clipLayerHintSchema, clipMotionSchema } from '@vev/shared'
import {
  createExecutionContext,
  createMessageBatch,
  env,
  getQueueResult,
  waitOnExecutionContext,
} from 'cloudflare:test'
import * as v from 'valibot'
import { describe, expect, it, vi } from 'vitest'

import type { Env } from '../env.ts'
import worker from '../index.ts'
import { annotateClip } from './annotate.ts'
import { enqueueAnnotation, ingestQueue, REGISTRATION_DELAY_SECONDS } from './consume.ts'
import type { AiRunner, JevImage } from './jev.ts'
import { askJev, choiceQuestion, JEV_MODEL, noulQuestion, scoreQuestion } from './jev.ts'
import { TAG_THRESHOLD, TAG_VOCABULARY } from './tags.ts'

/**
 * Annotation is tested against a FAKE `AI` binding. Workers AI has no local implementation — the
 * binding proxies to the real service even under miniflare — so a test using the real one would
 * bill an account, need network, and (today) fail on `AiGatewayError: 2021: Insufficient AI Gateway
 * credits` rather than on anything this code does.
 *
 * Three rules the fixtures below follow, each deliberate:
 *
 * 1. Every canned value is distinct from any default, fallback or first-enum-member, so no
 *    assertion here can pass against a constant that merely happens to match. `energy` comes back
 *    4, never 1 or 5; `motion` is `fast`, the LAST enum member, never `static`.
 * 2. Tag probabilities are expressed relative to `TAG_THRESHOLD`, never as literals, so the first
 *    tuning pass moves the threshold without touching these tests.
 * 3. The fake inspects the QUESTIONS it was asked and answers them, rather than replaying a fixed
 *    response. That is what lets a test assert the enum keys actually offered to jev — a missing
 *    option description is invisible to any test that only checks the answer.
 */

/** 3.2 over jev's zero-based levels 0-4 rounds to level 3, which is `energy` 4. */
const CANNED_ENERGY_SCORE = 3.2
const EXPECTED_ENERGY = 4
const ENERGY_LEVEL_COUNT = 5

/** Mirrors `annotate.ts`'s own budgets; the timeout test advances fake timers past both. */
const JEV_TIMEOUT_MS = 30_000
const DESCRIPTION_TIMEOUT_MS = 20_000

/** Never the first member of its enum, so no assertion can pass against a fallback that picks one. */
const cannedChoice = (id: string, offered: readonly string[]): string => {
  if (id === 'motion') {
    return 'fast'
  }
  if (id === 'density') {
    return 'sparse'
  }
  return id === 'layerHint' ? 'fg' : offered[0]
}

const CANNED_CONFIDENCE = 0.87
const CANNED_DESCRIPTION = 'Pale green ribbons fold slowly over a near-black field.'

/** Well under the threshold, and not 0 — a literal zero reads as an unanswered question. */
const LOW_TAG_PROBABILITY = 0.07

/**
 * Two tags just clear the threshold, one falls just under it, and one sits EXACTLY on it. The last
 * is the boundary case: `tagsFrom` compares strictly, so a probability equal to the threshold is
 * not a tag, and this fixture is what pins that as a decision rather than an accident.
 */
const TAGGED = new Set(['organic', 'psychedelic'])
const JUST_BELOW = 'glitch'
const EXACTLY_AT = 'minimal'

const tagProbability = (name: string): number => {
  if (TAGGED.has(name)) {
    return TAG_THRESHOLD + 0.01
  }
  if (name === JUST_BELOW) {
    return TAG_THRESHOLD - 0.01
  }
  return name === EXACTLY_AT ? TAG_THRESHOLD : LOW_TAG_PROBABILITY
}

/** `usesFeedback` is true and `usesAudio` is false, so exactly one derived tag is expected. */
const CLIP_DEPS: ClipDeps = {
  extensions: [],
  outputsUsed: [],
  sourcesUsed: [],
  usesAudio: false,
  usesFeedback: true,
}

const CLIP = {
  code: 'src(o0).scale(0.99).blend(noise(3, 0.1), 0.04).out()',
  deps: CLIP_DEPS,
  engine: 'hydra' as const,
  title: 'Slow fold',
}

/** Judged tags in vocabulary order, then the one derived from `CLIP_DEPS` — never from a model. */
const EXPECTED_TAGS = ['organic', 'psychedelic', 'feedback']

/** The wire shapes `jev.ts` is documented to send, restated here so the fake can assert on them. */
type WireQuestion =
  | { criteria: Record<string, string>; instructions: string; type: 'choice' }
  | { criteria: string[]; instructions: string; type: 'score' }
  | { criteria: { false: string; true: string }; instructions: string; type: 'noul' }

interface JevRequest {
  assets?: Record<string, { data_base64: string; format: string; type: string }>
  questions: Record<string, WireQuestion>
  state: string | { brief: string; stills: string[] }
}

interface FakeCall {
  inputs: unknown
  model: string
}

interface FakeOptions {
  /** Makes the description model fail, the way an unavailable model does. */
  readonly descriptionThrows?: boolean
  /** Replaces the whole jev response, for the malformed-shape cases. */
  readonly jevResponse?: unknown
  /** Makes every jev call throw, the way a gateway refusal does. */
  readonly jevThrows?: boolean
  /** Makes a jev call that carries images hang, the way a stalled beta feature would. */
  readonly imageCallsHang?: boolean
  /** Replaces the whole response to a jev call that carries images. */
  readonly imageResponse?: unknown
  /** Makes a jev call that carries images throw, the way a rejected or unsupported image does. */
  readonly imageCallsThrow?: boolean
  /** Replaces ONE answer, by question id — how a malformed or out-of-range answer is injected. */
  readonly override?: { readonly answer: unknown; readonly id: string }
}

interface FakeAi extends AiRunner {
  readonly calls: FakeCall[]
}

/** The documented answer shapes, including the `legend` / `probabilities` extras the adapter ignores. */
type WireAnswer =
  | { choice: string; confidence: number; probabilities: Record<string, number>; type: 'choice' }
  | {
      confidence: number
      legend: Record<string, string>
      probabilities: Record<string, number>
      score: number
      type: 'score'
    }
  | { noul: number; type: 'noul' }

const answerFor = (id: string, question: WireQuestion): WireAnswer => {
  if (question.type === 'score') {
    return {
      confidence: CANNED_CONFIDENCE,
      legend: { 0: 'calm', 4: 'intense' },
      probabilities: { 3: 0.71 },
      score: CANNED_ENERGY_SCORE,
      type: 'score',
    }
  }
  if (question.type === 'choice') {
    const keys = Object.keys(question.criteria)
    return {
      choice: cannedChoice(id, keys),
      confidence: CANNED_CONFIDENCE,
      probabilities: Object.fromEntries(keys.map((key) => [key, 1 / keys.length])),
      type: 'choice',
    }
  }
  return { noul: tagProbability(id.replace('tag:', '')), type: 'noul' }
}

const createFakeAi = (options: FakeOptions = {}): FakeAi => {
  const calls: FakeCall[] = []
  return {
    calls,
    // Every branch returns an already-settled value, so there is nothing to await; the `async`
    // keyword is nonetheless required, because `typescript/promise-function-async` demands it of
    // anything whose declared return type is a Promise — which `AiRunner.run` is.
    // oxlint-disable-next-line eslint/require-await -- see above: async is forced by promise-function-async, and there is nothing real to await in a fake
    run: async (model: string, inputs: unknown): Promise<unknown> => {
      calls.push({ inputs, model })

      if (model === JEV_MODEL) {
        if (options.jevThrows === true) {
          throw new Error('AiGatewayError: 2021: Insufficient AI Gateway credits')
        }
        const request = inputs as JevRequest
        if (request.assets !== undefined) {
          if (options.imageCallsThrow === true) {
            throw new Error('jev: image input is unavailable')
          }
          if (options.imageCallsHang === true) {
            return await Promise.withResolvers<never>().promise
          }
          if (options.imageResponse !== undefined) {
            return options.imageResponse
          }
        }
        if (options.jevResponse !== undefined) {
          return options.jevResponse
        }
        const answers = Object.fromEntries(
          Object.entries(request.questions).map(([id, question]) => [id, answerFor(id, question)]),
        )
        const { override } = options
        const answered = override === undefined ? answers : { ...answers, [override.id]: override.answer }
        // The envelope observed from the live model: answers under `answers`, `model` and `usage` beside them.
        return { answers: answered, model: 'jev-1.14.0', usage: { input_tokens: 1162, output_tokens: 69 } }
      }

      if (options.descriptionThrows === true) {
        throw new Error('description model is unavailable')
      }
      return { response: CANNED_DESCRIPTION }
    },
  }
}

const jevCalls = (ai: FakeAi): FakeCall[] => ai.calls.filter((call) => call.model === JEV_MODEL)

/** The first jev request the fake saw, so a test can assert on what was ASKED, not only on the answer. */
const firstJevRequest = (ai: FakeAi): JevRequest => {
  const [call] = jevCalls(ai)
  if (call === undefined) {
    throw new Error('the fake was never asked a jev question')
  }
  return call.inputs as JevRequest
}

/** The text of the brief jev was given, whether the state was a plain string or named some frames. */
const briefOf = (request: JevRequest): string =>
  v.is(v.string(), request.state) ? request.state : request.state.brief

const questionOf = (request: JevRequest, id: string): WireQuestion => {
  const question = request.questions[id]
  if (question === undefined) {
    throw new Error(`no question "${id}" was asked`)
  }
  return question
}

const choiceOptions = (request: JevRequest, id: string): Record<string, string> => {
  const question = questionOf(request, id)
  if (question.type !== 'choice') {
    throw new Error(`"${id}" was asked as a ${question.type}, not a choice`)
  }
  return question.criteria
}

const askedOnce = async (options: FakeOptions = {}): Promise<JevRequest> => {
  const ai = createFakeAi(options)
  await annotateClip(ai, CLIP)
  return firstJevRequest(ai)
}

describe('annotateClip — what it asks', () => {
  it('asks the enum choices with exactly the keys the clip schema accepts', async () => {
    const request = await askedOnce()
    expect(Object.keys(choiceOptions(request, 'motion')).toSorted()).toStrictEqual(
      [...clipMotionSchema.options].toSorted(),
    )
    expect(Object.keys(choiceOptions(request, 'density')).toSorted()).toStrictEqual(
      [...clipDensitySchema.options].toSorted(),
    )
    expect(Object.keys(choiceOptions(request, 'layerHint')).toSorted()).toStrictEqual(
      [...clipLayerHintSchema.options].toSorted(),
    )
  })

  it('gives every choice option a non-empty description, so no option is unanswerable', async () => {
    const request = await askedOnce()
    const described = ['motion', 'density', 'layerHint'].flatMap((id) =>
      Object.values(choiceOptions(request, id)).filter((text) => text.trim() !== ''),
    )
    const offered = ['motion', 'density', 'layerHint'].flatMap((id) =>
      Object.keys(choiceOptions(request, id)),
    )
    expect(described).toHaveLength(offered.length)
  })

  it('asks energy as a five-level, zero-based score', async () => {
    const question = questionOf(await askedOnce(), 'energy')
    expect(question.type).toBe('score')
    expect(question.criteria).toHaveLength(ENERGY_LEVEL_COUNT)
  })

  it('asks every tag in the vocabulary as a noul statement with both criteria', async () => {
    const request = await askedOnce()
    const asked = TAG_VOCABULARY.map((tag) => {
      const question = questionOf(request, `tag:${tag.name}`)
      return {
        instructions: question.instructions,
        type: question.type,
        whenFalse: question.type === 'noul' ? question.criteria.false : undefined,
        whenTrue: question.type === 'noul' ? question.criteria.true : undefined,
      }
    })
    expect(asked).toStrictEqual(
      TAG_VOCABULARY.map((tag) => ({
        instructions: tag.statement,
        type: 'noul',
        whenFalse: tag.whenFalse,
        whenTrue: tag.whenTrue,
      })),
    )
  })

  it('sends the clip code as the state jev judges', async () => {
    const request = await askedOnce()
    expect(briefOf(request)).toContain(CLIP.code)
  })
})

describe('annotateClip — what it stores', () => {
  it('converts a zero-based score into the spec integer energy', async () => {
    const result = await annotateClip(createFakeAi(), CLIP)
    expect(result.ok).toBe(true)
    expect(result.ok && result.annotation.energy).toBe(EXPECTED_ENERGY)
  })

  it('stores the chosen options as motion, density and layerHint', async () => {
    const result = await annotateClip(createFakeAi(), CLIP)
    expect(result.ok && result.annotation.motion).toBe('fast')
    expect(result.ok && result.annotation.density).toBe('sparse')
    expect(result.ok && result.annotation.layerHint).toBe('fg')
  })

  it('tags what is above the threshold and not what is below it', async () => {
    const result = await annotateClip(createFakeAi(), CLIP)
    const tags = result.ok ? result.annotation.tags : []
    expect(tags).toStrictEqual(EXPECTED_TAGS)
    expect(tags).not.toContain(JUST_BELOW)
  })

  it('does NOT tag a probability exactly equal to the threshold — the comparison is strict', async () => {
    const result = await annotateClip(createFakeAi(), CLIP)
    const tags = result.ok ? result.annotation.tags : []
    expect(tags).not.toContain(EXACTLY_AT)
  })

  it('derives the feedback tag from deps rather than asking jev about it', async () => {
    const ai = createFakeAi()
    const result = await annotateClip(ai, CLIP)
    const request = firstJevRequest(ai)
    // The fact is already known statically, so the question is never put to a probabilistic model.
    expect(Object.keys(request.questions)).not.toContain('tag:feedback')
    expect(result.ok && result.annotation.tags).toContain('feedback')
  })

  it('omits a derived tag whose dependency is absent', async () => {
    const result = await annotateClip(createFakeAi(), {
      ...CLIP,
      deps: { ...CLIP_DEPS, usesFeedback: false },
    })
    expect(result.ok && result.annotation.tags).not.toContain('feedback')
  })

  it('derives the audio-reactive tag when the clip reads audio', async () => {
    const result = await annotateClip(createFakeAi(), { ...CLIP, deps: { ...CLIP_DEPS, usesAudio: true } })
    expect(result.ok && result.annotation.tags).toContain('audio-reactive')
  })

  it('reports the confidence jev gave each typed answer, for the log', async () => {
    const result = await annotateClip(createFakeAi(), CLIP)
    expect(result.ok && result.confidence).toStrictEqual({
      density: CANNED_CONFIDENCE,
      energy: CANNED_CONFIDENCE,
      layerHint: CANNED_CONFIDENCE,
      motion: CANNED_CONFIDENCE,
    })
  })

  it('stores the text model description', async () => {
    const result = await annotateClip(createFakeAi(), CLIP)
    expect(result.ok && result.annotation.description).toBe(CANNED_DESCRIPTION)
  })

  it('keeps every other annotation when the description model fails', async () => {
    const result = await annotateClip(createFakeAi({ descriptionThrows: true }), CLIP)
    expect(result.ok && result.annotation.description).toBe('')
    expect(result.ok && result.annotation.energy).toBe(EXPECTED_ENERGY)
    expect(result.ok && result.annotation.tags).toStrictEqual(EXPECTED_TAGS)
  })
})

/** How a refusal came out: whether it failed, how many jev attempts it took, and why. */
const refusalOf = async (
  options: FakeOptions,
): Promise<{
  jevAttempts: number
  ok: boolean
  reason: string
}> => {
  const ai = createFakeAi(options)
  const result = await annotateClip(ai, CLIP)
  return { jevAttempts: jevCalls(ai).length, ok: result.ok, reason: result.ok ? '' : result.reason }
}

/** One initial attempt plus exactly one retry, then failure — never a throw, never a third try. */
const RETRY_THEN_FAIL = { jevAttempts: 2, ok: false }

describe('annotateClip — what it refuses', () => {
  it('refuses a score outside the levels the question offered', async () => {
    const { jevAttempts, ok } = await refusalOf({
      override: { answer: { confidence: CANNED_CONFIDENCE, score: 7.5, type: 'score' }, id: 'energy' },
    })
    expect({ jevAttempts, ok }).toStrictEqual(RETRY_THEN_FAIL)
  })

  it('refuses a choice that is not one of the options', async () => {
    const { jevAttempts, ok } = await refusalOf({
      override: {
        answer: { choice: 'tropical', confidence: CANNED_CONFIDENCE, type: 'choice' },
        id: 'motion',
      },
    })
    expect({ jevAttempts, ok }).toStrictEqual(RETRY_THEN_FAIL)
  })

  it('refuses an answer of the wrong type for the question asked', async () => {
    const { jevAttempts, ok } = await refusalOf({
      override: { answer: { noul: 0.5, type: 'noul' }, id: 'density' },
    })
    expect({ jevAttempts, ok }).toStrictEqual(RETRY_THEN_FAIL)
  })

  it('refuses a response missing a required field', async () => {
    const { jevAttempts, ok } = await refusalOf({
      override: { answer: { confidence: CANNED_CONFIDENCE, type: 'score' }, id: 'energy' },
    })
    expect({ jevAttempts, ok }).toStrictEqual(RETRY_THEN_FAIL)
  })

  it('refuses a response with a field of the wrong type', async () => {
    const { jevAttempts, ok } = await refusalOf({
      override: {
        answer: { confidence: CANNED_CONFIDENCE, score: 'quite high', type: 'score' },
        id: 'energy',
      },
    })
    expect({ jevAttempts, ok }).toStrictEqual(RETRY_THEN_FAIL)
  })

  it('refuses a response that answers nothing at all', async () => {
    const { jevAttempts, ok } = await refusalOf({ jevResponse: {} })
    expect({ jevAttempts, ok }).toStrictEqual(RETRY_THEN_FAIL)
  })

  it('refuses a response that is not an object', async () => {
    const { jevAttempts, ok } = await refusalOf({ jevResponse: 'the clip looks energetic' })
    expect({ jevAttempts, ok }).toStrictEqual(RETRY_THEN_FAIL)
  })

  it('reports a thrown call as a failure rather than throwing, and names the reason', async () => {
    const ai = createFakeAi({ jevThrows: true })
    const result = await annotateClip(ai, CLIP)
    expect(!result.ok && result.reason).toContain('Insufficient AI Gateway credits')
    expect(jevCalls(ai)).toHaveLength(2)
  })

  it('gives up on a call that never answers, rather than hanging the consumer forever', async () => {
    // Without a timeout this is the one failure that never reaches `failed`: the promise never
    // settles, the consumer never acks, the queue exhausts `max_retries` and drops the clip still
    // marked `pending`. Fake timers make the 30s budget a test that finishes in milliseconds.
    vi.useFakeTimers()
    try {
      // A binding that accepts the call and never settles — the hang this timeout exists for.
      const ai: FakeAi = { calls: [], run: async () => await Promise.withResolvers<never>().promise }
      const pending = annotateClip(ai, CLIP)
      await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS * 2 + DESCRIPTION_TIMEOUT_MS * 2 + 1000)
      const result = await pending
      expect(!result.ok && result.reason).toContain('did not answer within')
    } finally {
      vi.useRealTimers()
    }
  })

  it('reads answers from the observed envelope and ignores its model and usage siblings', async () => {
    const ai = createFakeAi()
    const result = await annotateClip(ai, CLIP)
    expect(result.ok && result.annotation.energy).toBe(EXPECTED_ENERGY)
    expect(jevCalls(ai)).toHaveLength(1)
  })

  it('refuses answers sitting at the top level instead of under `answers`', async () => {
    const answered = {
      density: { choice: 'sparse', confidence: 0.9, type: 'choice' },
    }
    const { jevAttempts, ok } = await refusalOf({ jevResponse: answered })
    expect({ jevAttempts, ok }).toStrictEqual(RETRY_THEN_FAIL)
  })

  it('never asks the description model when the typed questions failed', async () => {
    const ai = createFakeAi({ jevThrows: true })
    await annotateClip(ai, CLIP)
    expect(ai.calls.map((call) => call.model)).toStrictEqual([JEV_MODEL, JEV_MODEL])
  })
})

/** Distinct bytes per frame, so a test can tell which frame reached jev and in what order. */
const stillBytes = (tail: number): Uint8Array => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, tail, tail, tail])
const STILLS: readonly JevImage[] = [1, 2, 3].map((tail) => ({ bytes: stillBytes(tail), format: 'jpeg' }))

const decodeBase64 = (encoded: string): number[] =>
  Array.from(atob(encoded), (char) => char.codePointAt(0) ?? 0)

/** The frames a request carried, in the order its state names them. */
const framesOf = (request: JevRequest): number[][] => {
  const { state } = request
  if (v.is(v.string(), state)) {
    return []
  }
  return state.stills.map((key) => decodeBase64(request.assets?.[key]?.data_base64 ?? ''))
}

describe('annotateClip — stills', () => {
  it('shows jev the frames in recording order and still sends the code', async () => {
    const ai = createFakeAi()
    const result = await annotateClip(ai, { ...CLIP, stills: STILLS })

    expect(jevCalls(ai)).toHaveLength(1)
    const request = firstJevRequest(ai)
    expect(framesOf(request)).toStrictEqual(STILLS.map((still) => [...still.bytes]))
    expect(briefOf(request)).toContain(CLIP.code)
    expect(result.ok && result.evidence).toBe('stills')
  })

  it('stores the same annotation the code-only path stores when the answers are the same', async () => {
    const withStills = await annotateClip(createFakeAi(), { ...CLIP, stills: STILLS })
    const codeOnly = await annotateClip(createFakeAi(), CLIP)
    expect(withStills.ok && withStills.annotation).toStrictEqual(codeOnly.ok && codeOnly.annotation)
  })

  it('asks every question with frames that it asks without them', async () => {
    const withStills = createFakeAi()
    await annotateClip(withStills, { ...CLIP, stills: STILLS })
    const codeOnly = createFakeAi()
    await annotateClip(codeOnly, CLIP)
    expect(Object.keys(firstJevRequest(withStills).questions).toSorted()).toStrictEqual(
      Object.keys(firstJevRequest(codeOnly).questions).toSorted(),
    )
  })

  it('tells jev to judge motion from the code when frames are attached', async () => {
    const ai = createFakeAi()
    await annotateClip(ai, { ...CLIP, stills: STILLS })
    expect(questionOf(firstJevRequest(ai), 'motion').instructions).toContain('source code')
  })

  it('sends no frames for a clip that has none', async () => {
    const none = createFakeAi()
    const empty = createFakeAi()
    const first = await annotateClip(none, CLIP)
    const second = await annotateClip(empty, { ...CLIP, stills: [] })

    for (const ai of [none, empty]) {
      expect(jevCalls(ai)).toHaveLength(1)
      expect(firstJevRequest(ai).assets).toBeUndefined()
      expect(v.is(v.string(), firstJevRequest(ai).state)).toBe(true)
    }
    expect(first.ok && first.evidence).toBe('code')
    expect(second.ok && second.evidence).toBe('code')
  })

  it('retries with the code alone when the call with frames throws', async () => {
    const ai = createFakeAi({ imageCallsThrow: true })
    const result = await annotateClip(ai, { ...CLIP, stills: STILLS })

    const calls = jevCalls(ai).map((call) => call.inputs as JevRequest)
    expect(calls.map((request) => request.assets !== undefined)).toStrictEqual([true, false])
    expect(result.ok && result.evidence).toBe('code')
    expect(result.ok && result.annotation.energy).toBe(EXPECTED_ENERGY)
    expect(result.ok && result.annotation.description).toBe(CANNED_DESCRIPTION)
  })

  it('retries with the code alone when the call with frames returns something unusable', async () => {
    const ai = createFakeAi({ imageResponse: { answers: {}, model: 'jev-1.14.0' } })
    const result = await annotateClip(ai, { ...CLIP, stills: STILLS })

    expect(jevCalls(ai)).toHaveLength(2)
    expect(result.ok && result.evidence).toBe('code')
  })

  it('retries with the code alone when the call with frames never answers', async () => {
    vi.useFakeTimers()
    try {
      const ai = createFakeAi({ imageCallsHang: true })
      const pending = annotateClip(ai, { ...CLIP, stills: STILLS })
      await vi.advanceTimersByTimeAsync(JEV_TIMEOUT_MS + 1000)
      const result = await pending
      expect(jevCalls(ai)).toHaveLength(2)
      expect(result.ok && result.evidence).toBe('code')
    } finally {
      vi.useRealTimers()
    }
  })

  it('fails after exactly two calls when frames and code both fail, never a third', async () => {
    const ai = createFakeAi({ jevThrows: true })
    const result = await annotateClip(ai, { ...CLIP, stills: STILLS })

    expect(jevCalls(ai)).toHaveLength(2)
    expect(!result.ok && result.reason).toContain('Insufficient AI Gateway credits')
    expect(ai.calls.map((call) => call.model)).toStrictEqual([JEV_MODEL, JEV_MODEL])
  })
})

interface ClipRow {
  annotation_status: string
  author: string
  code: string
  density: string | null
  deps: string
  description: string | null
  energy: number | null
  layer_hint: string | null
  license: string
  motion: string | null
  palette: string | null
  slug: string
  tags: string | null
  title: string
}

/** Every NOT NULL column, so the row is a real one rather than a partial the schema would reject. */
const insertClip = async (id: string, stillKeys: readonly string[] | null = null): Promise<void> => {
  await env.DB.prepare(
    `insert into clips (annotation_status, author, code, commercial_ok, default_bars, deps, engine,
       id, isolated, license, modified, origin, original_code, params, reviewed, slug, still_keys, title)
     values ('pending', ?, ?, 0, 8, ?, 'hydra', ?, 0, 'CC BY 4.0', 0, 'imported', ?, '[]', 0, ?, ?, ?)`,
  )
    .bind(
      'Khoparzi',
      CLIP.code,
      JSON.stringify({
        extensions: [],
        outputsUsed: [],
        sourcesUsed: [],
        usesAudio: false,
        usesFeedback: true,
      }),
      id,
      CLIP.code,
      `hydra/slow-fold-${id}`,
      stillKeys === null ? null : JSON.stringify(stillKeys),
      CLIP.title,
    )
    .run()
}

const readClip = async (id: string): Promise<ClipRow> => {
  const row = await env.DB.prepare('select * from clips where id = ?').bind(id).first<ClipRow>()
  if (row === null) {
    throw new Error(`no clip ${id}`)
  }
  return row
}

/** The clip's OWN fields — the ones a failed annotation must leave exactly as it found them. */
const ownFields = (row: ClipRow) => ({
  author: row.author,
  code: row.code,
  deps: row.deps,
  license: row.license,
  slug: row.slug,
  title: row.title,
})

/** Every column annotation writes, so "nothing was half-written" is one assertion, not six. */
const annotatedFields = (row: ClipRow) => ({
  density: row.density,
  description: row.description,
  energy: row.energy,
  layerHint: row.layer_hint,
  motion: row.motion,
  status: row.annotation_status,
  tags: row.tags,
})

/**
 * What `getQueueResult` reports. Restated here because `@cloudflare/workers-types` does not export
 * the interface, so the inferred type does not resolve in this project's configuration.
 */
const queueOutcomeSchema = v.object({
  explicitAcks: v.array(v.string()),
  retryMessages: v.array(v.object({ msgId: v.string() })),
})

type QueueOutcome = v.InferOutput<typeof queueOutcomeSchema>

const runQueue = async (body: unknown, ai?: AiRunner): Promise<QueueOutcome> => {
  const batch = createMessageBatch('vev-ingest', [
    { attempts: 1, body, id: 'message-under-test', timestamp: new Date() },
  ])
  const ctx = createExecutionContext()
  // SAFETY: the pool's `env` already carries every real binding this Worker uses; this substitutes
  // the one binding that has no local implementation with the fake above.
  await ingestQueue(batch, { ...env, AI: ai } as unknown as Env)
  // SAFETY: `getQueueResult`'s declared return type, `FetcherQueueResult`, lives only in
  // `@cloudflare/workers-types/experimental` and so does not resolve against the non-experimental
  // typings this project uses; `QueueOutcome` above restates the two fields this suite reads.
  // Parsed rather than cast: `getQueueResult`'s declared return type, `FetcherQueueResult`, lives
  // only in `@cloudflare/workers-types/experimental` and does not resolve against the
  // non-experimental typings this project uses, so this both narrows it and checks that the pool
  // really did report the two fields these tests read.
  return v.parse(queueOutcomeSchema, await getQueueResult(batch, ctx))
}

/**
 * A fake `AI` whose first call finds the row already finished by another job, which is what a
 * stills job completing while the delayed registration job is still waiting on the model looks
 * like from the row. The values it leaves are distinct from anything `createFakeAi` returns.
 */
const finishedElsewhere = (id: string, inner: AiRunner): AiRunner => {
  let first = true
  return {
    run: async (model, inputs) => {
      if (first) {
        first = false
        await env.DB.prepare(
          "update clips set annotation_status = 'ok', energy = 1, description = 'annotated from stills' where id = ?",
        )
          .bind(id)
          .run()
      }
      return await inner.run(model, inputs)
    },
  }
}

describe('the ingest queue consumer', () => {
  it('writes the annotation and marks the clip ok', async () => {
    const id = crypto.randomUUID()
    await insertClip(id)

    const result = await runQueue({ clipId: id, trigger: 'stills' }, createFakeAi())
    expect(result.explicitAcks).toContain('message-under-test')

    const row = await readClip(id)
    expect(annotatedFields(row)).toStrictEqual({
      density: 'sparse',
      description: CANNED_DESCRIPTION,
      energy: EXPECTED_ENERGY,
      layerHint: 'fg',
      motion: 'fast',
      status: 'ok',
      tags: JSON.stringify(EXPECTED_TAGS),
    })
  })

  it('annotates once: the registration message stands down after the stills message has run', async () => {
    const id = crypto.randomUUID()
    await insertClip(id)
    await runQueue({ clipId: id, trigger: 'stills' }, createFakeAi())

    const result = await runQueue(
      { clipId: id, trigger: 'registered' },
      { run: async () => await Promise.reject(new Error('a second annotation must not call the model')) },
    )

    expect(result.explicitAcks).toContain('message-under-test')
    const { annotation_status: status } = await readClip(id)
    expect(status).toBe('ok')
  })

  it('does not let a stale registration job overwrite an annotation a stills job finished first', async () => {
    const id = crypto.randomUUID()
    await insertClip(id)

    await runQueue({ clipId: id, trigger: 'registered' }, finishedElsewhere(id, createFakeAi()))

    const row = await readClip(id)
    expect(row).toMatchObject({
      annotation_status: 'ok',
      description: 'annotated from stills',
      energy: 1,
    })
  })

  it('does not let a stale registration job mark a clip failed after a stills job annotated it', async () => {
    const id = crypto.randomUUID()
    await insertClip(id)

    await runQueue(
      { clipId: id, trigger: 'registered' },
      finishedElsewhere(id, createFakeAi({ jevThrows: true })),
    )

    const row = await readClip(id)
    expect(row).toMatchObject({ annotation_status: 'ok', energy: 1 })
  })

  it('keeps an annotation that exists when a later stills job fails', async () => {
    const id = crypto.randomUUID()
    await insertClip(id)
    await runQueue({ clipId: id, trigger: 'registered' }, createFakeAi())

    await runQueue({ clipId: id, trigger: 'stills' }, createFakeAi({ jevThrows: true }))

    const row = await readClip(id)
    expect(row).toMatchObject({ annotation_status: 'ok', energy: EXPECTED_ENERGY })
  })

  it('lets a stills job recover a clip whose registration annotation failed', async () => {
    const id = crypto.randomUUID()
    await insertClip(id)
    await runQueue({ clipId: id, trigger: 'registered' }, createFakeAi({ jevThrows: true }))
    const failed = await readClip(id)
    expect(failed.annotation_status).toBe('failed')

    await runQueue({ clipId: id, trigger: 'stills' }, createFakeAi())

    const recovered = await readClip(id)
    expect(recovered.annotation_status).toBe('ok')
  })

  it('annotates a clip whose stills never came when the registration message arrives', async () => {
    const id = crypto.randomUUID()
    await insertClip(id)
    await runQueue({ clipId: id, trigger: 'registered' }, createFakeAi())
    const { annotation_status: status } = await readClip(id)
    expect(status).toBe('ok')
  })

  it('never touches palette, which is computed from rendered frames rather than annotated', async () => {
    const id = crypto.randomUUID()
    await insertClip(id)
    await runQueue({ clipId: id, trigger: 'stills' }, createFakeAi())
    const row = await readClip(id)
    expect(row.palette).toBeNull()
  })

  it('marks the clip failed and writes no partial annotation', async () => {
    const id = crypto.randomUUID()
    await insertClip(id)

    const result = await runQueue({ clipId: id, trigger: 'stills' }, createFakeAi({ jevThrows: true }))
    expect(result.explicitAcks).toContain('message-under-test')
    expect(result.retryMessages).toHaveLength(0)

    const row = await readClip(id)
    expect(annotatedFields(row)).toStrictEqual({
      density: null,
      description: null,
      energy: null,
      layerHint: null,
      motion: null,
      status: 'failed',
      tags: null,
    })
  })

  it("leaves the clip's own fields untouched when annotation fails", async () => {
    const id = crypto.randomUUID()
    await insertClip(id)
    const inserted = await readClip(id)
    const before = ownFields(inserted)

    await runQueue({ clipId: id, trigger: 'stills' }, createFakeAi({ jevThrows: true }))

    const after = await readClip(id)
    expect(ownFields(after)).toStrictEqual(before)
  })

  it('marks the clip failed when there is no AI binding at all', async () => {
    const id = crypto.randomUUID()
    await insertClip(id)

    const result = await runQueue({ clipId: id, trigger: 'stills' })
    expect(result.explicitAcks).toContain('message-under-test')
    const row = await readClip(id)
    expect(row.annotation_status).toBe('failed')
  })

  it('acks and drops a message that is not an annotation request, rather than retrying forever', async () => {
    const result = await runQueue({ clip: 'not-a-clip-id' }, createFakeAi())
    expect(result.explicitAcks).toContain('message-under-test')
    expect(result.retryMessages).toHaveLength(0)
  })

  it('acks a message naming a clip that no longer exists', async () => {
    const result = await runQueue({ clipId: crypto.randomUUID(), trigger: 'stills' }, createFakeAi())
    expect(result.explicitAcks).toContain('message-under-test')
    expect(result.retryMessages).toHaveLength(0)
  })
})

describe('the ingest queue consumer — stills', () => {
  const putStill = async (key: string, tail: number): Promise<void> => {
    await env.MEDIA.put(key, stillBytes(tail))
  }

  it('annotates from the stored stills, in the order the row lists them', async () => {
    const id = crypto.randomUUID()
    const keys = [3, 1, 2].map((tail) => `stills/${id}/${tail}.jpg`)
    await Promise.all(
      [3, 1, 2].map(async (tail) => {
        await putStill(`stills/${id}/${tail}.jpg`, tail)
      }),
    )
    await insertClip(id, keys)

    const ai = createFakeAi()
    await runQueue({ clipId: id, trigger: 'stills' }, ai)

    expect(framesOf(firstJevRequest(ai))).toStrictEqual([3, 1, 2].map((tail) => [...stillBytes(tail)]))
    const { annotation_status: status } = await readClip(id)
    expect(status).toBe('ok')
  })

  it('annotates from the code when the row lists stills that R2 does not hold', async () => {
    const id = crypto.randomUUID()
    await insertClip(id, [`stills/${id}/0.jpg`, `stills/${id}/1.jpg`])

    const ai = createFakeAi()
    await runQueue({ clipId: id, trigger: 'stills' }, ai)

    expect(jevCalls(ai)).toHaveLength(1)
    expect(firstJevRequest(ai).assets).toBeUndefined()
    const { annotation_status: status } = await readClip(id)
    expect(status).toBe('ok')
  })

  it('uses the frames that exist when only some are missing', async () => {
    const id = crypto.randomUUID()
    await putStill(`stills/${id}/1.jpg`, 7)
    await insertClip(id, [`stills/${id}/0.jpg`, `stills/${id}/1.jpg`])

    const ai = createFakeAi()
    await runQueue({ clipId: id, trigger: 'stills' }, ai)

    expect(framesOf(firstJevRequest(ai))).toStrictEqual([[...stillBytes(7)]])
  })

  it('still annotates the clip from its code when the call with frames fails', async () => {
    const id = crypto.randomUUID()
    await putStill(`stills/${id}/0.jpg`, 1)
    await insertClip(id, [`stills/${id}/0.jpg`])

    const ai = createFakeAi({ imageCallsThrow: true })
    const result = await runQueue({ clipId: id, trigger: 'stills' }, ai)

    expect(result.explicitAcks).toContain('message-under-test')
    expect(annotatedFields(await readClip(id))).toStrictEqual({
      density: 'sparse',
      description: CANNED_DESCRIPTION,
      energy: EXPECTED_ENERGY,
      layerHint: 'fg',
      motion: 'fast',
      status: 'ok',
      tags: JSON.stringify(EXPECTED_TAGS),
    })
  })

  it('marks the clip failed when both the call with frames and the code-only retry fail', async () => {
    const id = crypto.randomUUID()
    await putStill(`stills/${id}/0.jpg`, 1)
    await insertClip(id, [`stills/${id}/0.jpg`])

    const ai = createFakeAi({ jevThrows: true })
    const result = await runQueue({ clipId: id, trigger: 'stills' }, ai)

    expect(result.explicitAcks).toContain('message-under-test')
    expect(jevCalls(ai)).toHaveLength(2)
    const { annotation_status: status } = await readClip(id)
    expect(status).toBe('failed')
  })
})

const fakeQueue = () => {
  const sent: { body: unknown; options: unknown }[] = []
  const send = async (body: unknown, options: unknown) => await Promise.resolve(sent.push({ body, options }))
  // SAFETY: `enqueueAnnotation` calls only `send`, which is the part of `Queue` this fake supplies.
  return { queue: { send } as unknown as Queue, sent }
}

describe(enqueueAnnotation, () => {
  it('makes a registered clip wait for its stills, and sends stills at once', async () => {
    const { queue, sent } = fakeQueue()
    await enqueueAnnotation({ QUEUE_INGEST: queue, VEV_MODE: 'cloud' }, 'clip', 'registered')
    await enqueueAnnotation({ QUEUE_INGEST: queue, VEV_MODE: 'cloud' }, 'clip', 'stills')
    expect(sent).toStrictEqual([
      {
        body: { clipId: 'clip', trigger: 'registered' },
        options: { delaySeconds: REGISTRATION_DELAY_SECONDS },
      },
      { body: { clipId: 'clip', trigger: 'stills' }, options: {} },
    ])
  })

  it('sends nothing in local mode, even though Void binds a local queue', async () => {
    const { queue, sent } = fakeQueue()
    await enqueueAnnotation({ QUEUE_INGEST: queue, VEV_MODE: 'local' }, 'clip', 'registered')
    expect(sent).toStrictEqual([])
  })

  it('does nothing when there is no queue binding', async () => {
    await expect(enqueueAnnotation({ VEV_MODE: 'cloud' }, 'clip', 'registered')).resolves.toBeUndefined()
  })
})

/**
 * `jev.ts`'s own range and membership guards, tested directly rather than through `annotateClip`.
 * Through `annotateClip` they are shadowed by the `v.parse(clipMotionSchema, ...)` that follows
 * them, so mutating the guard to accept anything leaves that path green — which is exactly the
 * kind of unprotected check these tests exist to pin.
 */
const runnerReturning = (answers: unknown): AiRunner => ({
  // oxlint-disable-next-line eslint/require-await -- async is forced by typescript/promise-function-async; a canned answer has nothing to await
  run: async () => ({ answers, model: 'jev-1.14.0', usage: { input_tokens: 1, output_tokens: 1 } }),
})

const TEMPO_OPTIONS = { andante: 'moderate', largo: 'slow', presto: 'quick' }

describe(askJev, () => {
  it('refuses a choice key that was never offered', async () => {
    const ai = runnerReturning({ tempo: { choice: 'prestissimo', confidence: 0.9, type: 'choice' } })
    await expect(askJev(ai, 'a clip', { tempo: choiceQuestion('How fast?', TEMPO_OPTIONS) })).rejects.toThrow(
      'was not one of its options',
    )
  })

  it('accepts a choice key that was offered', async () => {
    const ai = runnerReturning({ tempo: { choice: 'largo', confidence: 0.9, type: 'choice' } })
    const answers = await askJev(ai, 'a clip', { tempo: choiceQuestion('How fast?', TEMPO_OPTIONS) })
    expect(answers.tempo).toStrictEqual({ confidence: 0.9, key: 'largo', kind: 'choice' })
  })

  it('refuses a score above the last zero-based level', async () => {
    const ai = runnerReturning({ heat: { confidence: 0.9, score: 3.01, type: 'score' } })
    await expect(
      askJev(ai, 'a clip', { heat: scoreQuestion('How hot?', ['cold', 'warm', 'hot']) }),
    ).rejects.toThrow('outside its 0-2 levels')
  })

  it('accepts a score at the last zero-based level', async () => {
    const ai = runnerReturning({ heat: { confidence: 0.9, score: 2, type: 'score' } })
    const answers = await askJev(ai, 'a clip', {
      heat: scoreQuestion('How hot?', ['cold', 'warm', 'hot']),
    })
    expect(answers.heat).toStrictEqual({ confidence: 0.9, kind: 'score', score: 2 })
  })

  it('refuses a probability outside 0-1', async () => {
    const ai = runnerReturning({ wet: { noul: 1.4, type: 'noul' } })
    await expect(
      askJev(ai, 'a clip', { wet: noulQuestion('It is wet.', 'water', 'no water') }),
    ).rejects.toThrow('did not parse')
  })

  it('sends a noul question as a statement with both criteria', async () => {
    const seen: unknown[] = []
    const ai: AiRunner = {
      // oxlint-disable-next-line eslint/require-await -- as above
      run: async (_model: string, inputs: unknown) => {
        seen.push(inputs)
        return { answers: { wet: { noul: 0.3, type: 'noul' } } }
      },
    }
    await askJev(ai, 'a clip', { wet: noulQuestion('It is wet.', 'water', 'no water') })
    expect(seen).toStrictEqual([
      {
        questions: {
          wet: { criteria: { false: 'no water', true: 'water' }, instructions: 'It is wet.', type: 'noul' },
        },
        state: 'a clip',
      },
    ])
  })
})

describe('askJev with images', () => {
  it('sends each image as a base64 asset that the state names by key', async () => {
    const seen: unknown[] = []
    const ai: AiRunner = {
      // oxlint-disable-next-line eslint/require-await -- as above
      run: async (_model: string, inputs: unknown) => {
        seen.push(inputs)
        return { answers: { wet: { noul: 0.3, type: 'noul' } } }
      },
    }
    // 0xff 0xd8 0xff is a JPEG's first three bytes; base64 of those plus 0x00 is "/9j/AA==".
    const jpeg = { bytes: new Uint8Array([0xff, 0xd8, 0xff, 0x00]), format: 'jpeg' as const }
    const png = { bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47]), format: 'png' as const }
    await askJev(ai, 'a clip', { wet: noulQuestion('It is wet.', 'water', 'no water') }, [jpeg, png])
    expect(seen).toStrictEqual([
      {
        assets: {
          'still-0': { data_base64: '/9j/AA==', format: 'jpeg', type: 'image' },
          'still-1': { data_base64: 'iVBORw==', format: 'png', type: 'image' },
        },
        questions: {
          wet: { criteria: { false: 'no water', true: 'water' }, instructions: 'It is wet.', type: 'noul' },
        },
        state: { brief: 'a clip', stills: ['still-0', 'still-1'] },
      },
    ])
  })

  it('encodes an image larger than one base64 slice without corrupting it', async () => {
    const seen: { assets: Record<string, { data_base64: string }> }[] = []
    const ai: AiRunner = {
      // oxlint-disable-next-line eslint/require-await -- as above
      run: async (_model: string, inputs: unknown) => {
        seen.push(inputs as (typeof seen)[number])
        return { answers: { wet: { noul: 0.3, type: 'noul' } } }
      },
    }
    const bytes = Uint8Array.from({ length: 100_000 }, (_, index) => index % 251)
    await askJev(ai, 'a clip', { wet: noulQuestion('It is wet.', 'water', 'no water') }, [
      { bytes, format: 'jpeg' },
    ])
    const encoded = seen[0]?.assets['still-0']?.data_base64 ?? ''
    expect(Uint8Array.from(atob(encoded), (char) => char.codePointAt(0) ?? 0)).toStrictEqual(bytes)
  })
})

describe('registration enqueues annotation', () => {
  it('sends the new clip id to QUEUE_INGEST, which is what makes the whole pipeline run', async () => {
    const sent: unknown[] = []
    const queue = { send: async (body: unknown) => await Promise.resolve(sent.push(body)) }
    const ctx = createExecutionContext()

    const response = await worker.fetch(
      new Request('https://vev.test/api/clips', {
        body: JSON.stringify({
          author: 'Khoparzi',
          code: CLIP.code,
          engine: 'hydra',
          license: 'CC BY 4.0',
          title: CLIP.title,
        }),
        headers: { 'Cf-Access-Jwt-Assertion': 'zzz-not-a-real-jwt-zzz', 'content-type': 'application/json' },
        method: 'POST',
      }),
      // The pool's `env` carries the real bindings; this adds the queue `--env local` has none of.
      { ...env, QUEUE_INGEST: queue },
      ctx,
    )
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(201)
    const registered = v.parse(v.object({ id: v.string() }), await response.json())
    expect(sent).toStrictEqual([{ clipId: registered.id, trigger: 'registered' }])
  })

  it('still registers the clip when there is no queue binding at all', async () => {
    const ctx = createExecutionContext()
    const response = await worker.fetch(
      new Request('https://vev.test/api/clips', {
        body: JSON.stringify({
          author: 'Khoparzi',
          code: CLIP.code,
          engine: 'hydra',
          license: 'CC BY 4.0',
          title: CLIP.title,
        }),
        headers: { 'Cf-Access-Jwt-Assertion': 'zzz-not-a-real-jwt-zzz', 'content-type': 'application/json' },
        method: 'POST',
      }),
      // As above, with QUEUE_INGEST deliberately absent — local mode (§15.3).
      { ...env, QUEUE_INGEST: undefined },
      ctx,
    )
    await waitOnExecutionContext(ctx)
    expect(response.status).toBe(201)
  })
})
