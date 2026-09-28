// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Slot } from '@vev/shared'

/** Slot a is Hydra's o1, slot b is o2; o0 is the compositor's final output and o3 is the compositor's own spare buffer, not a clip's (spec §6.1). */
const BUFFER: Record<Slot, string> = { a: 'o1', b: 'o2' }

const OUT_CALL = /\.out\([^)]*\)/gu

/**
 * How many `.out(...)` calls — bare or with an argument — appear in `code`. `rewriteOut` and the
 * probe's multi-output refusal (`probe.ts`) both key off this same count, because both are facets
 * of the same constraint: a clip has exactly one buffer of its own (spec §6.1 — the compositor
 * owns `o0`/`o1`/`o2`/`o3`, a clip is only ever given one of `o1`/`o2` to write), so a clip may
 * legally call `.out(` at most once.
 */
export const countOutCalls = (code: string): number => [...code.matchAll(OUT_CALL)].length

/**
 * Point a clip's output at the buffer it has been given.
 *
 * A clip may only ever write its own slot buffer (spec §6.1), so if it makes exactly one
 * `.out(...)` call — bare or with an argument — that call is always the one rewritten to the slot
 * buffer, regardless of what it named. Rewriting a named call too, not just a bare one, is what
 * makes this give the same answer in either slot: the common pasted-Hydra shape `osc(10).out(o0)`
 * must render identically as slot a's clip and as slot b's, rather than registering cleanly in
 * whichever slot its hardcoded target happens to match and silently writing that slot's buffer
 * from the other deck (the hole in an earlier version of this rule, which left a single named call
 * alone).
 *
 * A clip with no `.out(` at all gets one appended, because a clip that renders nowhere is
 * indistinguishable from a broken one. A clip with two or more `.out(` calls is left completely
 * unrewritten — there is no way to tell which one the author meant as "the" output, and guessing
 * risks silently writing a buffer the compositor owns — and is refused before it ever runs, by the
 * probe (`probe.ts`'s `multi-output` reason), not here: `rewriteOut` stays a pure string transform
 * and reports nothing itself.
 */
export const rewriteOut = (code: string, slot: Slot): string => {
  const buffer = BUFFER[slot]
  const matches = [...code.matchAll(OUT_CALL)]

  if (matches.length !== 1) {
    return matches.length === 0 ? `${code.trimEnd()}.out(${buffer})` : code
  }

  const [match] = matches
  if (match.index === undefined) {
    return code
  }

  return `${code.slice(0, match.index)}.out(${buffer})${code.slice(match.index + match[0].length)}`
}
