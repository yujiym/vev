// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'

import { resolveSourceLink, sourceCommitUrl } from './source.ts'

describe(sourceCommitUrl, () => {
  it('points at the exact commit being served', () => {
    expect(sourceCommitUrl('https://example.com/acme/vev', 'abc1234')).toBe(
      'https://example.com/acme/vev/tree/abc1234',
    )
  })

  it('tolerates a trailing slash on the source url', () => {
    expect(sourceCommitUrl('https://example.com/acme/vev/', 'abc1234')).toBe(
      'https://example.com/acme/vev/tree/abc1234',
    )
  })

  it('falls back to the repository root when the commit is unknown', () => {
    expect(sourceCommitUrl('https://example.com/acme/vev', 'dev')).toBe('https://example.com/acme/vev')
  })
})

describe(resolveSourceLink, () => {
  it('links to the commit when a source url is configured', () => {
    expect(resolveSourceLink('https://github.com/example/fork', 'abc1234')).toStrictEqual({
      href: 'https://github.com/example/fork/tree/abc1234',
      kind: 'link',
    })
  })

  it('is missing rather than impersonating the upstream repository when unset', () => {
    expect(resolveSourceLink(undefined, 'abc1234')).toStrictEqual({ kind: 'missing' })
  })

  it('is missing for an empty string too', () => {
    expect(resolveSourceLink('', 'abc1234')).toStrictEqual({ kind: 'missing' })
  })
})
