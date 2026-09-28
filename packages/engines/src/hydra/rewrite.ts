// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Slot } from '@vev/shared'

/** Slot a is Hydra's o1, slot b is o2; o0 is the compositor's final output and o3 is the compositor's own spare buffer, not a clip's (spec §6.1). */
const BUFFER: Record<Slot, string> = { a: 'o1', b: 'o2' }

const IDENT_CHAR = /[$0-9A-Z_a-z]/u
const WHITESPACE = /\s/u

/**
 * If `code[i]` opens a line comment, block comment, or single/double/backtick-quoted string, the
 * index just past it; otherwise `i` unchanged. Template-literal `${...}` interpolations are not
 * parsed back into code — treating the whole literal as opaque text is a deliberate simplification
 * for clip source, which does not need it, over building a real tokenizer.
 */
const skipTrivia = (code: string, i: number): number => {
  if (code[i] === '/' && code[i + 1] === '/') {
    let j = i + 2
    while (j < code.length && code[j] !== '\n') {
      j += 1
    }
    return j
  }

  if (code[i] === '/' && code[i + 1] === '*') {
    let j = i + 2
    while (j < code.length && !(code[j] === '*' && code[j + 1] === '/')) {
      j += 1
    }
    return Math.min(j + 2, code.length)
  }

  if (code[i] === "'" || code[i] === '"' || code[i] === '`') {
    const quote = code[i]
    let j = i + 1
    while (j < code.length && code[j] !== quote) {
      j += code[j] === '\\' ? 2 : 1
    }
    return j + 1
  }

  return i
}

/** The index just past `code`'s matching `)` for the `(` at `openIndex`, or -1 if it is never closed. Walks through nested parens and, via `skipTrivia`, through any comments or strings in between — so a `)` inside a string argument is never mistaken for the call's own close. */
const matchParen = (code: string, openIndex: number): number => {
  let depth = 0
  let i = openIndex

  while (i < code.length) {
    const skipped = skipTrivia(code, i)
    if (skipped !== i) {
      i = skipped
      continue
    }

    if (code[i] === '(') {
      depth += 1
    } else if (code[i] === ')') {
      depth -= 1
      if (depth === 0) {
        return i + 1
      }
    }

    i += 1
  }

  return -1
}

interface OutCall {
  readonly end: number
  readonly start: number
}

/**
 * Every real `.out(...)` call in `code`, as `{ start, end }` spans covering the dot through the
 * matching `)` — never a `.out(` that is inside a comment or a string, and never a longer
 * identifier that merely starts the same way (`.output(`). This is a scanner over code positions,
 * not a regex over raw source: a regex cannot tell a live `.out(` from one sitting inside
 * `// commented out code` or `"a string mentioning .out()"`, which is exactly how an earlier
 * version of this file both miscounted a commented-out call as real AND missed
 * `osc(10). out (o3)` (whitespace between the dot and `out`, or between `out` and `(`, is legal
 * JavaScript and must still be recognised as the same call).
 */
const findOutCalls = (code: string): OutCall[] => {
  const calls: OutCall[] = []
  const n = code.length
  let i = 0

  while (i < n) {
    const skipped = skipTrivia(code, i)
    if (skipped !== i) {
      i = skipped
      continue
    }

    if (code[i] === '.') {
      const start = i
      let j = i + 1
      while (j < n && WHITESPACE.test(code[j])) {
        j += 1
      }

      if (code.slice(j, j + 3) === 'out' && !IDENT_CHAR.test(code[j + 3] ?? '')) {
        let k = j + 3
        while (k < n && WHITESPACE.test(code[k])) {
          k += 1
        }

        if (code[k] === '(') {
          const end = matchParen(code, k)
          if (end !== -1) {
            calls.push({ end, start })
            i = end
            continue
          }
        }
      }
    }

    i += 1
  }

  return calls
}

/**
 * How many real `.out(...)` calls — bare or with an argument, comments and strings excluded —
 * `code` makes. `rewriteOut` and the probe's multi-output refusal (`probe.ts`) both key off this
 * same count, because both are facets of the same constraint: a clip has exactly one buffer of its
 * own (spec §6.1 — the compositor owns `o0`/`o1`/`o2`/`o3`, a clip is only ever given one of
 * `o1`/`o2` to write), so a clip may legally call `.out(` at most once.
 */
export const countOutCalls = (code: string): number => findOutCalls(code).length

/**
 * Point a clip's output at the buffer it has been given.
 *
 * A clip may only ever write its own slot buffer (spec §6.1), so if it makes exactly one real
 * `.out(...)` call — bare or with an argument — that call is always the one rewritten to the slot
 * buffer, regardless of what it named. Rewriting a named call too, not just a bare one, is what
 * makes this give the same answer in either slot: the common pasted-Hydra shape `osc(10).out(o0)`
 * must render identically as slot a's clip and as slot b's, rather than registering cleanly in
 * whichever slot its hardcoded target happens to match and silently writing that slot's buffer
 * from the other deck (the hole in an earlier version of this rule, which left a single named call
 * alone).
 *
 * A clip with no real `.out(` at all gets one appended, because a clip that renders nowhere is
 * indistinguishable from a broken one. A clip with two or more real `.out(` calls is left
 * completely unrewritten — there is no way to tell which one the author meant as "the" output, and
 * guessing risks silently writing a buffer the compositor owns — and is refused before it ever
 * runs, by the probe (`probe.ts`'s `multi-output` reason), not here: `rewriteOut` stays a pure
 * string transform and reports nothing itself.
 */
export const rewriteOut = (code: string, slot: Slot): string => {
  const buffer = BUFFER[slot]
  const calls = findOutCalls(code)

  if (calls.length === 0) {
    return `${code.trimEnd()}.out(${buffer})`
  }

  if (calls.length > 1) {
    return code
  }

  const [call] = calls
  return `${code.slice(0, call.start)}.out(${buffer})${code.slice(call.end)}`
}
