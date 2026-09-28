// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Slot } from '@vev/shared'

/** Slot a is Hydra's o1, slot b is o2; o0 is the compositor's final output and o3 is the compositor's own spare buffer, not a clip's (spec §6.1). */
const BUFFER: Record<Slot, string> = { a: 'o1', b: 'o2' }

const BARE_OUT = /\.out\(\s*\)/gu

/**
 * Point a clip's output at the buffer it has been given.
 *
 * Only the LAST argument-free `.out()` is rewritten: a call that already names
 * a target (`.out(o3)`, say) is left alone. A clip that never calls `.out()`
 * gets one appended, because a clip that renders nowhere is indistinguishable
 * from a broken one.
 */
export const rewriteOut = (code: string, slot: Slot): string => {
  const buffer = BUFFER[slot]
  const matches = [...code.matchAll(BARE_OUT)]
  const last = matches.at(-1)

  if (last?.index === undefined) {
    return `${code.trimEnd()}.out(${buffer})`
  }

  return `${code.slice(0, last.index)}.out(${buffer})${code.slice(last.index + last[0].length)}`
}
