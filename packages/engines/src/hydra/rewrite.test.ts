// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'

import { countOutCalls, rewriteOut } from './rewrite.ts'

describe(rewriteOut, () => {
  it('sends a bare out() to the slot buffer', () => {
    expect(rewriteOut('osc(10).out()', 'a')).toBe('osc(10).out(o1)')
    expect(rewriteOut('osc(10).out()', 'b')).toBe('osc(10).out(o2)')
  })

  it('leaves whitespace inside the call alone', () => {
    expect(rewriteOut('osc(10).out( )', 'a')).toBe('osc(10).out(o1)')
  })

  it('appends an out() when the clip never calls one', () => {
    expect(rewriteOut('osc(10)', 'b')).toBe('osc(10).out(o2)')
  })

  it('rewrites a single out() that names a target, overriding it', () => {
    expect(rewriteOut('noise().out(o3)', 'a')).toBe('noise().out(o1)')
  })

  it('rewrites a single named out() the same pasted-Hydra shape people actually paste', () => {
    expect(rewriteOut('osc(10).out(o0)', 'a')).toBe('osc(10).out(o1)')
    expect(rewriteOut('osc(10).out(o0)', 'b')).toBe('osc(10).out(o2)')
  })

  it('leaves two or more out() calls completely unrewritten, bare or named', () => {
    const named = 'osc(10).out(o1)\nnoise().out(o2)'
    expect(rewriteOut(named, 'a')).toBe(named)

    const bare = 'osc(10).out()\nnoise().out()'
    expect(rewriteOut(bare, 'a')).toBe(bare)
  })

  it('gives the same verdict for the same clip in either slot', () => {
    const single = 'osc(10).out(o3)'
    expect(rewriteOut(single, 'a')).toBe('osc(10).out(o1)')
    expect(rewriteOut(single, 'b')).toBe('osc(10).out(o2)')

    const multi = 'osc(10).out(o1)\nnoise().out(o2)'
    expect(rewriteOut(multi, 'a')).toBe(multi)
    expect(rewriteOut(multi, 'b')).toBe(multi)
  })
})

describe(countOutCalls, () => {
  it('counts zero, one and many out() calls, bare or named', () => {
    expect(countOutCalls('osc(10)')).toBe(0)
    expect(countOutCalls('osc(10).out()')).toBe(1)
    expect(countOutCalls('osc(10).out(o3)')).toBe(1)
    expect(countOutCalls('osc(10).out(o1)\nnoise().out(o2)')).toBe(2)
  })
})
