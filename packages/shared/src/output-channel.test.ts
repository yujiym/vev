// SPDX-License-Identifier: AGPL-3.0-or-later
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'

import { outputMessageSchema } from './output-channel.ts'

const clip = { code: 'osc(10).out()', id: 'quiet' }

describe('output channel messages', () => {
  it('accepts a load message', () => {
    const parsed = v.parse(outputMessageSchema, { clip, kind: 'load', slot: 'a' })
    expect(parsed.kind).toBe('load')
  })

  it('accepts a switch message carrying the wall-clock moment it fires', () => {
    const parsed = v.parse(outputMessageSchema, {
      at: 1_735_689_600_000,
      kind: 'switch',
      to: 'b',
      transition: { bars: 2, kind: 'crossfade' },
    })
    expect(parsed.kind === 'switch' && parsed.at).toBe(1_735_689_600_000)
  })

  it('rejects a slot that is not one of the two buffers', () => {
    const result = v.safeParse(outputMessageSchema, { clip, kind: 'load', slot: 'c' })
    expect(result.success).toBe(false)
  })

  it('rejects a transition kind the compositor cannot render', () => {
    const result = v.safeParse(outputMessageSchema, {
      at: 1,
      kind: 'switch',
      to: 'b',
      transition: { bars: 1, kind: 'asciify' },
    })
    expect(result.success).toBe(false)
  })

  it('accepts the output window announcing itself', () => {
    expect(v.parse(outputMessageSchema, { kind: 'hello' }).kind).toBe('hello')
  })

  it('rejects a message with no kind at all', () => {
    expect(v.safeParse(outputMessageSchema, { clip, slot: 'a' }).success).toBe(false)
  })

  it('rejects Infinity in clock.bpm', () => {
    const result = v.safeParse(outputMessageSchema, {
      beatsPerBar: 4,
      bpm: Infinity,
      downbeatAt: 0,
      kind: 'clock',
    })
    expect(result.success).toBe(false)
  })

  it('rejects whitespace-only string in clip.code', () => {
    const result = v.safeParse(outputMessageSchema, {
      clip: { code: '   ', id: 'blank' },
      kind: 'load',
      slot: 'a',
    })
    expect(result.success).toBe(false)
  })
})
