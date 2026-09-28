// SPDX-License-Identifier: AGPL-3.0-or-later
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'

import { newClipSchema } from './clip.ts'

const minimalPayload = {
  author: 'khoparzi',
  code: 'osc(10,0.1,1).out()',
  engine: 'hydra',
  license: 'CC BY 4.0',
  title: 'aquatic blubs',
}

describe('clip registration payload', () => {
  it('accepts a minimal registration payload', () => {
    const result = v.safeParse(newClipSchema, minimalPayload)
    expect(result.success).toBe(true)
  })

  it('rejects a payload carrying a client-supplied id', () => {
    const result = v.safeParse(newClipSchema, {
      ...minimalPayload,
      id: 'clip_should_not_be_here',
    })
    expect(result.success).toBe(false)
  })

  it('rejects the empty string for license', () => {
    const result = v.safeParse(newClipSchema, { ...minimalPayload, license: '' })
    expect(result.success).toBe(false)
  })

  it('accepts "unknown" for license', () => {
    const result = v.safeParse(newClipSchema, { ...minimalPayload, license: 'unknown' })
    expect(result.success).toBe(true)
  })

  it('accepts energy at the boundaries 1 and 5', () => {
    const low = v.safeParse(newClipSchema, { ...minimalPayload, energy: 1 })
    const high = v.safeParse(newClipSchema, { ...minimalPayload, energy: 5 })
    expect(low.success).toBe(true)
    expect(high.success).toBe(true)
  })

  it('rejects energy outside 1..5 or non-integral', () => {
    const zero = v.safeParse(newClipSchema, { ...minimalPayload, energy: 0 })
    const six = v.safeParse(newClipSchema, { ...minimalPayload, energy: 6 })
    const fractional = v.safeParse(newClipSchema, { ...minimalPayload, energy: 2.5 })
    expect(zero.success).toBe(false)
    expect(six.success).toBe(false)
    expect(fractional.success).toBe(false)
  })

  it('rejects a motion value outside the enum', () => {
    const result = v.safeParse(newClipSchema, { ...minimalPayload, motion: 'glacial' })
    expect(result.success).toBe(false)
  })

  it('rejects a density value outside the enum', () => {
    const result = v.safeParse(newClipSchema, { ...minimalPayload, density: 'chunky' })
    expect(result.success).toBe(false)
  })

  it('rejects a layerHint value outside the enum', () => {
    const result = v.safeParse(newClipSchema, { ...minimalPayload, layerHint: 'mid' })
    expect(result.success).toBe(false)
  })

  it('accepts each origin value', () => {
    const imported = v.safeParse(newClipSchema, { ...minimalPayload, origin: 'imported' })
    const authored = v.safeParse(newClipSchema, { ...minimalPayload, origin: 'authored' })
    const generated = v.safeParse(newClipSchema, {
      ...minimalPayload,
      generator: { at: 1_727_600_000_000, model: 'gpt-5', prompt: 'a slow kaleidoscope' },
      origin: 'generated',
    })
    expect(imported.success).toBe(true)
    expect(authored.success).toBe(true)
    expect(generated.success).toBe(true)
  })

  it('rejects origin "generated" without a generator', () => {
    const result = v.safeParse(newClipSchema, { ...minimalPayload, origin: 'generated' })
    expect(result.success).toBe(false)
  })

  it('accepts each annotationStatus value', () => {
    const pending = v.safeParse(newClipSchema, {
      ...minimalPayload,
      annotationStatus: 'pending',
    })
    const ok = v.safeParse(newClipSchema, { ...minimalPayload, annotationStatus: 'ok' })
    const failed = v.safeParse(newClipSchema, {
      ...minimalPayload,
      annotationStatus: 'failed',
    })
    expect(pending.success).toBe(true)
    expect(ok.success).toBe(true)
    expect(failed.success).toBe(true)
  })

  it('rejects an annotationStatus value outside the enum', () => {
    const result = v.safeParse(newClipSchema, {
      ...minimalPayload,
      annotationStatus: 'annotating',
    })
    expect(result.success).toBe(false)
  })
})
