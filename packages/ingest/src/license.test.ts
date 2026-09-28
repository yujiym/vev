// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'

import { extractLicense } from './license.ts'

describe(extractLicense, () => {
  it('reads a "license:" header line', () => {
    const info = extractLicense('// license: CC BY 4.0\nosc(10).out()')
    expect(info.license).toBe('CC BY 4.0')
  })

  it('reads an "@author" header line', () => {
    const info = extractLicense('// @author Khoparzi\nosc(10).out()')
    expect(info.author).toBe('Khoparzi')
  })

  it('reads a "source:" header line', () => {
    const info = extractLicense('// source: https://hydra.ojack.xyz/?sketch=1\nosc(10).out()')
    expect(info.sourceUrl).toBe('https://hydra.ojack.xyz/?sketch=1')
  })

  it('returns an empty object for code with no header, rather than inventing values', () => {
    const info = extractLicense('osc(10, 0.1, 1.2).kaleid(4).out()')
    expect(info).toStrictEqual({})
  })

  it('reads all three header lines from one comment block', () => {
    const info = extractLicense(
      '// @author Khoparzi\n// license: CC BY 4.0\n// source: https://hydra.ojack.xyz/?sketch=1\nosc(10).out()',
    )
    expect(info).toStrictEqual({
      author: 'Khoparzi',
      license: 'CC BY 4.0',
      sourceUrl: 'https://hydra.ojack.xyz/?sketch=1',
    })
  })
})
