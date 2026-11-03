// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The annotator's tag layer: the probability a judged tag must clear, the two tags that are facts
 * about a clip's code rather than judgements about its output, and the vocabulary itself.
 *
 * The vocabulary is defined in `@vev/shared` rather than here because the annotator is no longer
 * its only reader — the steering chat's tag dictionary (`@vev/decision`) names the same tags — and
 * it is re-exported so the annotator keeps reading its questions and its threshold from one module.
 */
export { TAG_VOCABULARY } from '@vev/shared'
export type { TagDefinition } from '@vev/shared'

/**
 * The probability above which a tag is applied.
 *
 * UNMEASURED GUESS, and so is the size of the vocabulary. Neither has been tuned against a real
 * library, because no clip has been annotated yet (the account held no AI Gateway credits until
 * 2026-11-03, so `typesafe/jev` has never answered an annotation). It is exported, and the tests
 * assert relative to it (`TAG_THRESHOLD + 0.01` is tagged, `TAG_THRESHOLD - 0.01` is not),
 * precisely so the first tuning pass moves one number here and breaks nothing.
 */
export const TAG_THRESHOLD = 0.6

/**
 * The tags that are FACTS about a clip's code rather than judgements about its output.
 *
 * Both come from `analyzeHydra`'s dependency analysis (spec §11.1), which reads the source
 * statically at registration: `src(o0)` is feedback and `a.fft` is audio, and neither is a matter
 * of opinion. They are surfaced as tags because the library filters on tags — a performer looking
 * for feedback clips searches tags, not `deps` — but they are never asked of a model, because a
 * probabilistic answer that disagreed with the static one would leave the row self-contradictory
 * with nothing to break the tie.
 */
export const derivedTags = (deps: { usesAudio: boolean; usesFeedback: boolean }): string[] => {
  const tags: string[] = []
  if (deps.usesFeedback) {
    tags.push('feedback')
  }
  if (deps.usesAudio) {
    tags.push('audio-reactive')
  }
  return tags
}
