// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'

import { countOutCalls, outCallTargets, rewriteOut } from './rewrite.ts'

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

  it('finds a call with whitespace between the dot and out and between out and the paren', () => {
    expect(rewriteOut('osc(10). out (o3)', 'a')).toBe('osc(10).out(o1)')
  })

  it('finds a call with a newline between the dot and the name', () => {
    expect(rewriteOut('osc(10).\n  out(o3)', 'a')).toBe('osc(10).out(o1)')
  })

  it('does not count a call inside a line comment', () => {
    expect(rewriteOut('osc(10).out()\n// noise().out()', 'a')).toBe('osc(10).out(o1)\n// noise().out()')
  })

  it('does not count a call inside a block comment', () => {
    const code = 'osc(10).out()\n/* noise().out()\n   solid().out() */'
    expect(rewriteOut(code, 'a')).toBe('osc(10).out(o1)\n/* noise().out()\n   solid().out() */')
  })

  it('does not count a call inside a string', () => {
    expect(rewriteOut('text("see .out() docs").out()', 'a')).toBe('text("see .out() docs").out(o1)')
  })

  it('does not mistake .output( for an output call', () => {
    expect(rewriteOut('osc(10).output(x).out()', 'a')).toBe('osc(10).output(x).out(o1)')
  })

  it('finds a call hidden inside a template literal interpolation, and refuses alongside a trailing call', () => {
    // oxlint-disable-next-line eslint/no-template-curly-in-string -- this is Hydra clip source text used as test fixture data, not a real interpolation
    const code = 'text(`hello ${noise().out(o3)}`).out()'
    expect(countOutCalls(code)).toBe(2)
    expect(rewriteOut(code, 'a')).toBe(code)
  })

  it('rewrites the single call when it is the only one, even hidden inside an interpolation', () => {
    // oxlint-disable-next-line eslint/no-template-curly-in-string -- this is Hydra clip source text used as test fixture data, not a real interpolation
    expect(rewriteOut('text(`${noise().out(o3)}`)', 'a')).toBe('text(`${noise().out(o1)}`)')
  })

  it('changes nothing for an interpolation with no output call in it', () => {
    // oxlint-disable-next-line eslint/no-template-curly-in-string -- this is Hydra clip source text used as test fixture data, not a real interpolation
    expect(rewriteOut('text(`plain ${bpm} text`).out()', 'a')).toBe('text(`plain ${bpm} text`).out(o1)')
  })

  it('handles a template literal nested inside an interpolation', () => {
    // oxlint-disable-next-line eslint/no-template-curly-in-string -- this is Hydra clip source text used as test fixture data, not a real interpolation
    const code = 'text(`${`${noise().out(o3)}`}`).out()'
    expect(countOutCalls(code)).toBe(2)
    expect(rewriteOut(code, 'a')).toBe(code)
  })

  it('does not end an interpolation early on a brace that is inside a string inside it', () => {
    // oxlint-disable-next-line eslint/no-template-curly-in-string -- this is Hydra clip source text used as test fixture data, not a real interpolation
    expect(rewriteOut('osc(10).out(`${"}"}`)', 'a')).toBe('osc(10).out(o1)')
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

describe(outCallTargets, () => {
  it('names the buffer a single call targets', () => {
    expect(outCallTargets('osc(10).out(o1)')).toStrictEqual(['o1'])
  })

  it('names each buffer in source order, duplicates kept — the caller decides what to do with them', () => {
    expect(outCallTargets('osc(10).out(o2)\nnoise().out(o1)\nshape().out(o2)')).toStrictEqual([
      'o2',
      'o1',
      'o2',
    ])
  })

  it('names nothing for a bare .out(), whose target is the slot buffer rather than anything written', () => {
    expect(outCallTargets('osc(10).out()')).toStrictEqual([])
  })

  it('skips a call inside a line comment, unlike a regex over raw source', () => {
    expect(outCallTargets('// noise().out(o2)\nosc(10).out(o1)')).toStrictEqual(['o1'])
  })

  it('tolerates whitespace around the dot and the paren, unlike a regex over raw source', () => {
    expect(outCallTargets('osc(10). out ( o3 )')).toStrictEqual(['o3'])
  })

  it('names nothing for an argument that is not a plain o0-o3 identifier, since its target is not knowable from the text', () => {
    expect(outCallTargets('osc(10).out(buffers[i])')).toStrictEqual([])
  })
})
