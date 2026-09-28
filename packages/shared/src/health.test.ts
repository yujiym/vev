// SPDX-License-Identifier: AGPL-3.0-or-later
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'

import { healthResponseSchema } from './health.ts'

describe('health response schema', () => {
  it('accepts a local-mode health response', () => {
    const parsed = v.parse(healthResponseSchema, {
      commit: 'abc1234',
      mode: 'local',
      ok: true,
      settingsRows: 0,
    })
    expect(parsed.mode).toBe('local')
  })

  it('rejects an unknown mode', () => {
    const result = v.safeParse(healthResponseSchema, {
      commit: 'abc1234',
      mode: 'venue',
      ok: true,
      settingsRows: 0,
    })
    expect(result.success).toBe(false)
  })

  it('rejects an empty commit', () => {
    const result = v.safeParse(healthResponseSchema, {
      commit: '',
      mode: 'local',
      ok: true,
      settingsRows: 0,
    })
    expect(result.success).toBe(false)
  })

  it('rejects negative settingsRows', () => {
    const result = v.safeParse(healthResponseSchema, {
      commit: 'abc1234',
      mode: 'local',
      ok: true,
      settingsRows: -1,
    })
    expect(result.success).toBe(false)
  })

  it('rejects non-integer settingsRows', () => {
    const result = v.safeParse(healthResponseSchema, {
      commit: 'abc1234',
      mode: 'local',
      ok: true,
      settingsRows: 1.5,
    })
    expect(result.success).toBe(false)
  })
})
