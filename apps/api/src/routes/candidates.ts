// SPDX-License-Identifier: AGPL-3.0-or-later
import { vValidator } from '@hono/valibot-validator'
import { chooseTransition, filterCandidates, rankByRules } from '@vev/decision'
import type { RankedCandidate } from '@vev/decision'
import {
  candidateClipSchema,
  candidateRequestSchema,
  candidateResponseSchema,
  candidateResultSchema,
  clipEnergySchema,
  DEFAULT_PROVIDER_ID,
  decisionStateSchema,
} from '@vev/shared'
import type { CandidateClip, CandidateResult, ClipEnergy, DecisionState, TransitionSpec } from '@vev/shared'
import { asc, eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { Hono } from 'hono'
import * as v from 'valibot'

import { clipsTable } from '../db/clips.ts'
import { tracksTable } from '../db/tracks.ts'
import type { Env } from '../env.ts'
import type { AiRunner } from '../ingest/jev.ts'
import { askJev, choiceQuestion, scoreQuestion } from '../ingest/jev.ts'

/**
 * §8.4's default provider timeout. A candidate request sits on the show's path — the screen asks
 * right after the current clip starts (§8.3) — so the rule ranking, which is already computed, is
 * worth more than a slow answer.
 */
const DECISION_TIMEOUT_MS = 800

/** The control screen shows three candidates (spec §7, §8.1 step 4). */
const RETURNED_CANDIDATES = 3

/** Spec §9.1 calls crossfade the default transition; a request with no track still needs one. */
const DEFAULT_TRANSITION: TransitionSpec = { bars: 2, kind: 'crossfade' }

/**
 * The five levels of the `score` question, lowest first. jev scores are zero-based across however
 * many criteria are given, so five descriptions are energy 1-5 once `energyFromScore` converts.
 */
const INTENSITY_LEVELS: readonly string[] = [
  'Still or barely moving: a calm image a viewer could rest on indefinitely.',
  'Gentle: slow drift, a slow colour change, nothing abrupt.',
  'Moderate: continuous visible movement at a comfortable pace.',
  'Busy: fast movement, strong contrast changes, several things happening at once.',
  'Overwhelming: violent, strobing or chaotic — the most intense a clip gets.',
]

interface CandidateRow {
  readonly annotationStatus: CandidateClip['annotationStatus']
  readonly commercialOk: boolean
  readonly deps: { readonly usesFeedback: boolean }
  readonly description: string | null
  readonly energy: ClipEnergy | null
  readonly engine: CandidateClip['engine']
  readonly id: string
  readonly tags: string[] | null
}

/**
 * Rejects `work` if it has not settled within `ms`. The timer is always cleared, so a call that
 * answered in time does not keep the isolate alive waiting for a timeout that no longer matters.
 */
const settleWithin = async <T>(work: Promise<T>, ms: number): Promise<T> => {
  const expiry = Promise.withResolvers<never>()
  const timer = setTimeout(() => {
    expiry.reject(new Error(`candidates: the decision provider did not answer within ${ms}ms`))
  }, ms)
  try {
    return await Promise.race([work, expiry.promise])
  } finally {
    clearTimeout(timer)
  }
}

/** jev answers a float across the zero-based levels 0-4; `Clip.energy` is 1-5. */
const energyFromScore = (score: number): ClipEnergy =>
  v.parse(clipEnergySchema, Math.min(5, Math.max(1, Math.round(score) + 1)))

/** A candidate as the model sees it in a `choice` option; its title is not part of the decision state (§8.2). */
const describe = (clip: CandidateClip): string =>
  [
    clip.description ?? 'No description.',
    `engine ${clip.engine}.`,
    clip.energy === undefined ? 'energy unknown.' : `energy ${clip.energy}/5.`,
    clip.tags === undefined || clip.tags.length === 0 ? 'no tags.' : `tags ${clip.tags.join(', ')}.`,
  ].join(' ')

interface ModelAnswer {
  readonly chosenId: string
  readonly confidence?: number
  readonly energy: ClipEnergy
}

/**
 * Spec §8.2's questions, all in one call: which of the K clips fits best, and how intense the
 * visuals should be. Returns `undefined` rather than throwing for every failure — no answer in
 * time, a transport error, an empty or unparseable answer — because §0 principle 2 says a decision
 * failure must never stop the show.
 */
const askModel = async (
  ai: AiRunner,
  state: DecisionState,
  clips: readonly CandidateClip[],
): Promise<ModelAnswer | undefined> => {
  const options = Object.fromEntries(clips.map((clip) => [clip.id, describe(clip)]))

  try {
    const answers = await settleWithin(
      askJev(ai, JSON.stringify(state), {
        energy: scoreQuestion('How intense should the next clip be?', INTENSITY_LEVELS),
        next: choiceQuestion('Which clip should play next?', options),
      }),
      DECISION_TIMEOUT_MS,
    )

    const { next, energy: intensity } = answers
    if (next.kind !== 'choice' || intensity.kind !== 'score') {
      console.error('candidates: the decision provider answered the wrong question types')
      return undefined
    }

    return {
      chosenId: next.key,
      confidence: next.confidence,
      energy: energyFromScore(intensity.score),
    }
  } catch (error) {
    console.error('candidates: decision provider failed; using the rule ranking', error)
    return undefined
  }
}

/**
 * Puts the model's choice first and, when it gave one, its confidence in that clip's score. The
 * other clips keep the rule score that produced their order: a `choice` answer is one selection
 * with a confidence, not a probability per option, and inventing per-option probabilities would
 * dress a rule score up as the model's. `source` is what tells them apart.
 */
const putChoiceFirst = (ranked: readonly RankedCandidate[], answer: ModelAnswer): RankedCandidate[] => {
  const choiceIndex = ranked.findIndex((candidate) => candidate.clip.id === answer.chosenId)
  if (choiceIndex === -1) {
    return [...ranked]
  }

  const chosen = ranked[choiceIndex]
  if (chosen === undefined) {
    return [...ranked]
  }

  return [
    { ...chosen, score: answer.confidence ?? chosen.score },
    ...ranked.filter((_, index) => index !== choiceIndex),
  ]
}

const toResult = (ranked: RankedCandidate, decision: boolean): CandidateResult => {
  const result: CandidateResult = {
    clipId: ranked.clip.id,
    reason: ranked.reason,
    score: ranked.score,
    source: decision ? 'decision' : 'fallback',
  }
  if (decision) {
    result.providerId = DEFAULT_PROVIDER_ID
  }
  return v.parse(candidateResultSchema, result)
}

/**
 * `POST /api/candidates`: spec §8.1's filter → rank pipeline, with the decision provider as an
 * optional re-ranker.
 *
 * The library is read whole because step (2) of §8.1 — the embedding search that narrows it before
 * the model — belongs to M3's Vectorize work; this route is the half that works without it. The
 * model only ever sees the top K.
 *
 * No decision failure becomes a 5xx. An absent `AI` (local mode, §15.3), a timeout, a refused call
 * and an unparseable answer all return the rule ranking with `source: "fallback"`, because a show
 * mid-set has no use for a failure that it has already recovered from.
 */
export const candidatesRoutes = new Hono<{ Bindings: Env }>().post(
  '/',
  vValidator('json', candidateRequestSchema),
  async (c) => {
    const body = c.req.valid('json')
    const db = drizzle(c.env.DB)

    const trackRows =
      body.trackId === undefined
        ? []
        : await db
            .select({ defaultTransition: tracksTable.defaultTransition, mode: tracksTable.mode })
            .from(tracksTable)
            .where(eq(tracksTable.id, body.trackId))
    const [track] = trackRows
    if (body.trackId !== undefined && track === undefined) {
      return c.text('Not Found', 404)
    }

    const rows = await db
      .select({
        annotationStatus: clipsTable.annotationStatus,
        commercialOk: clipsTable.commercialOk,
        deps: clipsTable.deps,
        description: clipsTable.description,
        energy: clipsTable.energy,
        engine: clipsTable.engine,
        id: clipsTable.id,
        tags: clipsTable.tags,
      })
      .from(clipsTable)
      .orderBy(asc(clipsTable.title))

    const current = rows.find((row) => row.id === body.currentClipId)
    if (current === undefined) {
      return c.text('Not Found', 404)
    }

    const clips = rows.map((row: CandidateRow) =>
      v.parse(candidateClipSchema, {
        annotationStatus: row.annotationStatus,
        commercialOk: row.commercialOk,
        description: row.description ?? undefined,
        energy: row.energy ?? undefined,
        engine: row.engine,
        id: row.id,
        tags: row.tags ?? undefined,
        usesFeedback: row.deps.usesFeedback,
      }),
    )
    const byId = new Map(clips.map((clip) => [clip.id, clip]))
    const defaultTransition = track?.defaultTransition ?? DEFAULT_TRANSITION

    // §14.2: a commercial track excludes every clip not cleared for commercial use. Either signal
    // makes the request commercial, so a client cannot switch the track's own rule off.
    const commercial = body.commercial || track?.mode === 'commercial'
    const ranked = rankByRules(
      filterCandidates({
        clips,
        commercial,
        currentClipId: body.currentClipId,
        direction: body.direction,
        historyIds: body.historyIds,
      }),
      { direction: body.direction, historyIds: body.historyIds, section: body.section },
    )
    const shortlist = ranked.slice(0, body.limit)

    let ordered = ranked
    let answer: ModelAnswer | undefined
    if (c.env.AI !== undefined && shortlist.length > 0) {
      const state: DecisionState = v.parse(decisionStateSchema, {
        candidates: shortlist.map((candidate) => candidate.clip),
        current: {
          description: current.description ?? undefined,
          energy: current.energy ?? undefined,
          engine: current.engine,
          id: current.id,
        },
        history: body.historyIds.flatMap((id) => {
          const clip = byId.get(id)
          return clip === undefined ? [] : [{ energy: clip.energy, engine: clip.engine, id: clip.id }]
        }),
        prompt: body.direction?.text ?? '',
        section: { current: body.section, next: body.nextSection },
      })

      answer = await askModel(
        c.env.AI,
        state,
        shortlist.map((candidate) => candidate.clip),
      )
      if (answer !== undefined) {
        // Re-rank the shortlist at the intensity the model asked for, then put its own choice first.
        // The rest of the library is not re-ranked: the model never saw it, so its answer cannot be
        // about those clips.
        ordered = putChoiceFirst(
          rankByRules(
            shortlist.map((candidate) => candidate.clip),
            {
              direction: body.direction,
              energyTarget: answer.energy,
              historyIds: body.historyIds,
              section: body.section,
            },
          ),
          answer,
        )
      }
    }

    const candidates = ordered
      .slice(0, RETURNED_CANDIDATES)
      .map((candidate) => toResult(candidate, candidate.clip.id === answer?.chosenId))

    const top = ordered[0]?.clip
    const suggestedTransition =
      top === undefined
        ? defaultTransition
        : chooseTransition({
            current: { energy: current.energy ?? undefined, engine: current.engine },
            defaultTransition,
            next: { energy: top.energy, engine: top.engine, usesFeedback: top.usesFeedback },
            nextSection: body.nextSection,
          })

    return c.json(v.parse(candidateResponseSchema, { candidates, suggestedTransition }))
  },
)
