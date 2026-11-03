// SPDX-License-Identifier: AGPL-3.0-or-later
import { candidateResponseSchema } from '@vev/shared'
import type { CandidateResponse, Direction } from '@vev/shared'
import { env, SELF } from 'cloudflare:test'
import * as v from 'valibot'
import { beforeEach, describe, expect, it } from 'vitest'

import type { Env } from '../src/env.ts'
import { server } from '../src/index.ts'
import type { AiRunner } from '../src/ingest/jev.ts'

const ACCESS_HEADERS = { 'Cf-Access-Jwt-Assertion': 'zzz-not-a-real-jwt-zzz' }

const readJson = async <T>(response: Response): Promise<T> =>
  // SAFETY: every call site below names the exact shape this suite's own route just produced —
  // asserting it here just gives the test body a typed value to read fields off of.
  await response.json()

interface ClipOverrides {
  commercialOk?: boolean
  title?: string
}

/**
 * Registers a clip through the real route and returns its server-generated id. Commercial use is
 * cleared by default here because the registration schema defaults it off — a test that wants an
 * uncleared clip has to say so.
 */
const registerClip = async (overrides: ClipOverrides = {}): Promise<string> => {
  const response = await SELF.fetch('https://vev.test/api/clips', {
    body: JSON.stringify({
      author: 'Khoparzi',
      code: 'osc(10, 0.1, 1.2).kaleid(4).out()',
      commercialOk: true,
      engine: 'hydra',
      license: 'CC BY 4.0',
      title: 'Aquatic blubs',
      ...overrides,
    }),
    headers: { 'content-type': 'application/json', ...ACCESS_HEADERS },
    method: 'POST',
  })
  expect(response.status).toBe(201)
  const body = await readJson<{ id: string }>(response)
  return body.id
}

interface CandidateOverrides {
  commercial?: boolean
  direction?: Direction
  historyIds?: string[]
  limit?: number
  nextSection?: string
  section?: string
  trackId?: string
}

/** The body `POST /api/candidates` accepts, with the current clip already in the library. */
const candidateRequest = (currentClipId: string, overrides: CandidateOverrides = {}) => ({
  currentClipId,
  historyIds: [],
  ...overrides,
})

const postCandidates = async (body: unknown, bindings?: Env): Promise<Response> =>
  bindings === undefined
    ? await SELF.fetch('https://vev.test/api/candidates', {
        body: JSON.stringify(body),
        headers: { 'content-type': 'application/json', ...ACCESS_HEADERS },
        method: 'POST',
      })
    : await server.request(
        'https://vev.test/api/candidates',
        {
          body: JSON.stringify(body),
          headers: { 'content-type': 'application/json', ...ACCESS_HEADERS },
          method: 'POST',
        },
        bindings,
      )

const readCandidates = async (response: Response): Promise<CandidateResponse> =>
  v.parse(candidateResponseSchema, await readJson(response))

/**
 * A fake `AI` binding that answers jev's documented questions: a `choice` over the clip ids it
 * was actually asked about, and a `score` for intensity. `choose` lets a test pick which option
 * the model settles on without hard-coding an order the route is free to change.
 */
const fakeAi = (
  choose: (optionIds: readonly string[]) => string,
  score = 4,
  confidence = 0.91,
): AiRunner => ({
  run: async (_model, inputs) => {
    const request = inputs as {
      questions: {
        energy: { criteria: readonly string[] }
        next: { criteria: Readonly<Record<string, string>> }
      }
    }
    const optionIds = Object.keys(request.questions.next.criteria)

    return await Promise.resolve({
      answers: {
        energy: { score, type: 'score' },
        next: { choice: choose(optionIds), confidence, type: 'choice' },
      },
      model: 'jev-1.14.0',
      usage: { input_tokens: 1, output_tokens: 1 },
    })
  },
})

const envWithAi = (ai: AiRunner): Env => ({ ...env, AI: ai }) as unknown as Env

describe('POST /api/candidates', () => {
  beforeEach(async () => {
    // The pool isolates storage per test file, not per test, so each case starts from an empty
    // library instead of inheriting the previous case's clips.
    await env.DB.prepare('delete from clips').run()
  })

  it('returns three rule-ranked candidates and one suggested transition', async () => {
    const current = await registerClip({ title: 'Current' })
    const library = [
      await registerClip({ title: 'One' }),
      await registerClip({ title: 'Two' }),
      await registerClip({ title: 'Three' }),
      await registerClip({ title: 'Four' }),
    ]
    const libraryIds = new Set(library)

    const response = await postCandidates(candidateRequest(current))
    expect(response.status).toBe(200)

    const body = await readCandidates(response)
    expect(body.candidates).toHaveLength(3)
    expect(
      body.candidates.every(
        (candidate) =>
          candidate.clipId !== current &&
          libraryIds.has(candidate.clipId) &&
          candidate.source === 'fallback' &&
          candidate.providerId === undefined &&
          candidate.score >= 0 &&
          candidate.score <= 1,
      ),
    ).toBe(true)
    expect(body.suggestedTransition.kind).toBe('crossfade')
  })

  it('refuses a request with no Access assertion header', async () => {
    const current = await registerClip()
    const response = await SELF.fetch('https://vev.test/api/candidates', {
      body: JSON.stringify(candidateRequest(current)),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    })
    expect(response.status).toBe(403)
  })

  it('rejects a body that does not name the current clip', async () => {
    const response = await SELF.fetch('https://vev.test/api/candidates', {
      body: JSON.stringify({ historyIds: [] }),
      headers: { 'content-type': 'application/json', ...ACCESS_HEADERS },
      method: 'POST',
    })
    expect(response.status).toBe(400)
  })

  it('answers 404 when the current clip does not exist', async () => {
    const response = await postCandidates(candidateRequest('no-such-clip'))
    expect(response.status).toBe(404)
  })

  it('leaves out clips whose licence is not cleared for commercial use', async () => {
    const current = await registerClip({ title: 'Current' })
    const cleared = await registerClip({ title: 'Cleared' })
    const borrowed = await registerClip({ commercialOk: false, title: 'Borrowed' })

    const response = await postCandidates(candidateRequest(current, { commercial: true }))

    expect(response.status).toBe(200)
    const body = await readCandidates(response)
    const ids = body.candidates.map((candidate) => candidate.clipId)
    expect(ids).not.toContain(borrowed)
    expect(ids).toContain(cleared)
  })

  it('puts the model’s choice first and marks it as a decision', async () => {
    const current = await registerClip({ title: 'Current' })
    const library = [
      await registerClip({ title: 'One' }),
      await registerClip({ title: 'Two' }),
      await registerClip({ title: 'Three' }),
      await registerClip({ title: 'Four' }),
    ]

    const response = await postCandidates(
      candidateRequest(current),
      envWithAi(fakeAi((optionIds) => optionIds[1] ?? optionIds[0])),
    )

    expect(response.status).toBe(200)
    const body = await readCandidates(response)
    expect(library).toContain(body.candidates[0]?.clipId)
    expect(body.candidates[0]).toMatchObject({
      providerId: 'cf-jev',
      score: 0.91,
      source: 'decision',
    })
    expect(body.candidates.slice(1).every((candidate) => candidate.source === 'fallback')).toBe(true)
  })

  it('returns the rule ranking when the decision provider throws', async () => {
    const current = await registerClip({ title: 'Current' })
    await registerClip({ title: 'One' })
    await registerClip({ title: 'Two' })
    await registerClip({ title: 'Three' })

    const response = await postCandidates(
      candidateRequest(current),
      envWithAi({
        run: async () => await Promise.reject(new Error('provider refused the call')),
      }),
    )

    expect(response.status).toBe(200)
    const body = await readCandidates(response)
    expect(body.candidates).toHaveLength(3)
    expect(body.candidates.every((candidate) => candidate.source === 'fallback')).toBe(true)
  })

  it('returns the rule ranking when the decision provider is slower than 800ms', async () => {
    const current = await registerClip({ title: 'Current' })
    await registerClip({ title: 'One' })
    await registerClip({ title: 'Two' })
    await registerClip({ title: 'Three' })

    const neverAnswers = Promise.withResolvers<unknown>()
    const started = Date.now()
    const response = await postCandidates(
      candidateRequest(current),
      envWithAi({ run: async () => await neverAnswers.promise }),
    )
    const elapsed = Date.now() - started

    expect(response.status).toBe(200)
    expect(elapsed).toBeGreaterThanOrEqual(800)
    expect(elapsed).toBeLessThan(5000)
    const body = await readCandidates(response)
    expect(body.candidates).toHaveLength(3)
    expect(body.candidates.every((candidate) => candidate.source === 'fallback')).toBe(true)
  })
})
