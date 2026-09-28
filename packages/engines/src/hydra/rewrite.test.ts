// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'

import { rewriteOut } from './rewrite.ts'

describe(rewriteOut, () => {
  it('sends a bare out() to the slot buffer', () => {
    expect(rewriteOut('osc(10).out()', 'a')).toBe('osc(10).out(o1)')
    expect(rewriteOut('osc(10).out()', 'b')).toBe('osc(10).out(o2)')
  })

  it('leaves whitespace inside the call alone', () => {
    expect(rewriteOut('osc(10).out( )', 'a')).toBe('osc(10).out(o1)')
  })

  it('rewrites only the final out(), so intermediate buffers keep their targets', () => {
    expect(rewriteOut('noise().out(o3)\nsrc(o3).kaleid().out()', 'a')).toBe(
      'noise().out(o3)\nsrc(o3).kaleid().out(o1)',
    )
  })

  it('appends an out() when the clip never calls one', () => {
    expect(rewriteOut('osc(10)', 'b')).toBe('osc(10).out(o2)')
  })
})
