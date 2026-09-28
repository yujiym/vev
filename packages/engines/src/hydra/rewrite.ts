// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Slot } from '@vev/shared'

/** Slot a is Hydra's o1, slot b is o2; o0 is the compositor's final output and o3 is the compositor's own spare buffer, not a clip's (spec §6.1). */
const BUFFER: Record<Slot, string> = { a: 'o1', b: 'o2' }

const IDENT_CHAR = /[$0-9A-Z_a-z]/u
const WHITESPACE = /\s/u

interface OutCall {
  readonly end: number
  readonly start: number
}

/** A `.out(`'s own argument list, open until its matching `)`. `outCallStart` (the index of the `.`) is what lets closing it record the finished span in `calls`. */
interface ParenRegion {
  depth: number
  readonly closesOn: ')'
  readonly outCallStart?: number
}

/** A template literal's `${...}` interpolation, open until its matching `}`. */
interface BraceRegion {
  depth: number
  readonly closesOn: '}'
}

/** The clip itself: live code, open until the end of the string, with no closing character of its own. */
interface TopRegion {
  readonly closesOn: null
}

/** A backtick string's literal text — inert, unlike the three regions above, all of which are live code scanned the same way. */
interface TemplateRegion {
  readonly kind: 'template'
}

type CodeRegion = BraceRegion | ParenRegion | TopRegion
type Region = CodeRegion | TemplateRegion

const isTemplateRegion = (region: Region): region is TemplateRegion => 'kind' in region

const skipLineComment = (code: string, i: number): number => {
  let j = i + 2
  while (j < code.length && code[j] !== '\n') {
    j += 1
  }
  return j
}

const skipBlockComment = (code: string, i: number): number => {
  let j = i + 2
  while (j < code.length && !(code[j] === '*' && code[j + 1] === '/')) {
    j += 1
  }
  return Math.min(j + 2, code.length)
}

/** Single- or double-quoted string only. A backtick template literal is handled by `advanceInTemplate`/`advanceInCode` instead, since — unlike these — it can contain live `${...}` code. */
const skipString = (code: string, i: number): number => {
  const quote = code[i]
  let j = i + 1
  while (j < code.length && code[j] !== quote) {
    j += code[j] === '\\' ? 2 : 1
  }
  return j + 1
}

/** Tracks `region`'s own paren nesting when `code[i]` is `(` or `)`; pops and records the finished call span in `calls` on the matching close. Returns the index just past `code[i]`, or `undefined` if `code[i]` is neither. */
const advanceParenRegion = (
  region: ParenRegion,
  code: string,
  i: number,
  stack: Region[],
  calls: OutCall[],
): number | undefined => {
  if (code[i] === '(') {
    region.depth += 1
    return i + 1
  }

  if (code[i] === ')') {
    if (region.depth === 0) {
      stack.pop()
      if (region.outCallStart !== undefined) {
        calls.push({ end: i + 1, start: region.outCallStart })
      }
      return i + 1
    }
    region.depth -= 1
    return i + 1
  }

  return undefined
}

/** Tracks `region`'s own brace nesting when `code[i]` is `{` or `}` — an object literal or block inside the interpolation nests first, so this is what keeps it from being mistaken for the interpolation's own close. Returns the index just past `code[i]`, or `undefined` if `code[i]` is neither. */
const advanceBraceRegion = (
  region: BraceRegion,
  code: string,
  i: number,
  stack: Region[],
): number | undefined => {
  if (code[i] === '{') {
    region.depth += 1
    return i + 1
  }

  if (code[i] === '}') {
    if (region.depth === 0) {
      stack.pop()
      return i + 1
    }
    region.depth -= 1
    return i + 1
  }

  return undefined
}

/** If `code[i]` is the `.` of a real `.out(` call — matching whitespace between the dot and `out` and between `out` and `(`, and never a longer identifier that merely starts the same way (`.output(`) — pushes a new `ParenRegion` for its argument list and returns the index just past the `(`; otherwise `undefined`. */
const tryEnterOutCall = (code: string, i: number, stack: Region[]): number | undefined => {
  const n = code.length
  let j = i + 1
  while (j < n && WHITESPACE.test(code[j])) {
    j += 1
  }

  if (code.slice(j, j + 3) !== 'out' || IDENT_CHAR.test(code[j + 3] ?? '')) {
    return undefined
  }

  let k = j + 3
  while (k < n && WHITESPACE.test(code[k])) {
    k += 1
  }

  if (code[k] !== '(') {
    return undefined
  }

  stack.push({ closesOn: ')', depth: 0, outCallStart: i })
  return k + 1
}

/** One step of the scan while inside a `TemplateRegion`: an escape, the closing backtick, the start of an interpolation (pushes a `BraceRegion`), or an ordinary character of the literal's text. */
const advanceInTemplate = (code: string, i: number, stack: Region[]): number => {
  if (code[i] === '\\') {
    return i + 2
  }

  if (code[i] === '`') {
    stack.pop()
    return i + 1
  }

  if (code[i] === '$' && code[i + 1] === '{') {
    stack.push({ closesOn: '}', depth: 0 })
    return i + 2
  }

  return i + 1
}

/** One step of the scan while inside a `CodeRegion` (`top`, a `.out(`'s arguments, or an interpolation) — a comment, a string, the start of a template literal, this region's own bracket tracking, a real `.out(` call, or an ordinary character. */
const advanceInCode = (
  code: string,
  i: number,
  region: CodeRegion,
  stack: Region[],
  calls: OutCall[],
): number => {
  if (code[i] === '/' && code[i + 1] === '/') {
    return skipLineComment(code, i)
  }

  if (code[i] === '/' && code[i + 1] === '*') {
    return skipBlockComment(code, i)
  }

  if (code[i] === "'" || code[i] === '"') {
    return skipString(code, i)
  }

  if (code[i] === '`') {
    stack.push({ kind: 'template' })
    return i + 1
  }

  if (region.closesOn === ')') {
    const next = advanceParenRegion(region, code, i, stack, calls)
    if (next !== undefined) {
      return next
    }
  }

  if (region.closesOn === '}') {
    const next = advanceBraceRegion(region, code, i, stack)
    if (next !== undefined) {
      return next
    }
  }

  if (code[i] === '.') {
    const next = tryEnterOutCall(code, i, stack)
    if (next !== undefined) {
      return next
    }
  }

  return i + 1
}

/**
 * Every real `.out(...)` call in `code`, as `{ start, end }` spans covering the dot through the
 * matching `)` — never one inside a comment, a string, or inert template-literal text, but
 * including one hidden inside a template literal's live `${...}` interpolation (which genuinely
 * executes: `` text(`hello ${noise().out(o3)}`) `` would otherwise count zero calls while the clip
 * silently writes a buffer it does not own — structurally the same failure a plain `.out(` regex
 * over raw source has, just reached through a narrower path).
 *
 * This is a single-pass, explicit-stack scanner over code positions (`Region` above), not a regex
 * or a set of mutually recursive functions: a `${...}` interpolation can itself contain a nested
 * template literal with its own interpolation, arbitrarily deep, and an explicit stack (pushed by
 * `advanceInCode`/`advanceInTemplate`/`tryEnterOutCall`, popped by `advanceParenRegion`/
 * `advanceBraceRegion`/`advanceInTemplate`) handles that without the scanner needing to call
 * itself.
 *
 * **Deliberately out of scope: regex literals.** This scanner has no notion of a `/…/` regex
 * literal, so one containing something that merely looks like `.out(`, a comment marker, or a
 * quote gets walked into as if it were division followed by ordinary code, and could be
 * double-counted as a real call — refusing an otherwise legitimate clip. Telling a regex literal
 * from division apart syntactically needs to know whether the previous token was an operand or an
 * operator, which is where hand-written JS lexers classically go wrong, and the failure mode here
 * is a refusal the author can see and rephrase (drop the regex, or move the `.out(` call outside
 * it) — the opposite direction from the silent-miswrite hole this scanner exists to close. Weighed
 * and left out, not missed.
 */
const findOutCalls = (code: string): OutCall[] => {
  const calls: OutCall[] = []
  const stack: Region[] = [{ closesOn: null }]
  let i = 0

  while (i < code.length) {
    const region = stack.at(-1)
    if (!region) {
      break
    }

    i = isTemplateRegion(region)
      ? advanceInTemplate(code, i, stack)
      : advanceInCode(code, i, region, stack, calls)
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
