// SPDX-License-Identifier: AGPL-3.0-or-later
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'

import { transitionSpecSchema } from './playback-types.ts'

describe('playback types', () => {
  it('rejects Infinity in transition.bars', () => {
    const result = v.safeParse(transitionSpecSchema, {
      bars: Infinity,
      kind: 'cut',
    })
    expect(result.success).toBe(false)
  })
})
