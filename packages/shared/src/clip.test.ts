// SPDX-License-Identifier: AGPL-3.0-or-later
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'

import { clipSchema, newClipSchema, newTrackSchema } from './clip.ts'

const minimalPayload = {
  author: 'khoparzi',
  code: 'osc(10,0.1,1).out()',
  engine: 'hydra',
  license: 'CC BY 4.0',
  title: 'aquatic blubs',
}

const storedClipPayload = {
  annotationStatus: 'pending',
  author: 'khoparzi',
  code: 'osc(10,0.1,1).out()',
  commercialOk: false,
  defaultBars: 8,
  deps: {
    extensions: [],
    outputsUsed: [],
    sourcesUsed: [],
    usesAudio: false,
    usesFeedback: false,
  },
  engine: 'hydra',
  id: 'clip_aquatic_blubs',
  isolated: false,
  license: 'CC BY 4.0',
  modified: false,
  origin: 'imported',
  originalCode: 'osc(10,0.1,1).out()',
  params: [],
  reviewed: false,
  slug: 'hydra/khoparzi-aquatic-blubs',
  title: 'aquatic blubs',
}

const minimalTrackPayload = {
  defaultTransition: { bars: 0, kind: 'cut' },
  items: [],
  mode: 'noncommercial',
  title: 'a track',
  visibility: 'private',
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

  it('rejects a payload carrying a client-supplied isolated', () => {
    const result = v.safeParse(newClipSchema, { ...minimalPayload, isolated: false })
    expect(result.success).toBe(false)
  })

  it('rejects a payload claiming origin "generated"', () => {
    const result = v.safeParse(newClipSchema, { ...minimalPayload, origin: 'generated' })
    expect(result.success).toBe(false)
  })

  it('accepts the origins a registrant may legitimately claim', () => {
    const imported = v.safeParse(newClipSchema, { ...minimalPayload, origin: 'imported' })
    const authored = v.safeParse(newClipSchema, { ...minimalPayload, origin: 'authored' })
    expect(imported.success).toBe(true)
    expect(authored.success).toBe(true)
  })

  it('rejects the empty string for license', () => {
    const result = v.safeParse(newClipSchema, { ...minimalPayload, license: '' })
    expect(result.success).toBe(false)
  })

  it('accepts license "unknown" paired with commercialOk false', () => {
    const result = v.safeParse(newClipSchema, {
      ...minimalPayload,
      commercialOk: false,
      license: 'unknown',
    })
    expect(result.success).toBe(true)
  })

  it('rejects license "unknown" paired with commercialOk true', () => {
    const result = v.safeParse(newClipSchema, {
      ...minimalPayload,
      commercialOk: true,
      license: 'unknown',
    })
    expect(result.success).toBe(false)
  })
})

describe('stored clip', () => {
  it('accepts a fully annotated clip', () => {
    const result = v.safeParse(clipSchema, storedClipPayload)
    expect(result.success).toBe(true)
  })

  it('accepts energy at the boundaries 1 and 5', () => {
    const low = v.safeParse(clipSchema, { ...storedClipPayload, energy: 1 })
    const high = v.safeParse(clipSchema, { ...storedClipPayload, energy: 5 })
    expect(low.success).toBe(true)
    expect(high.success).toBe(true)
  })

  it('rejects energy outside 1..5 or non-integral', () => {
    const zero = v.safeParse(clipSchema, { ...storedClipPayload, energy: 0 })
    const six = v.safeParse(clipSchema, { ...storedClipPayload, energy: 6 })
    const fractional = v.safeParse(clipSchema, { ...storedClipPayload, energy: 2.5 })
    expect(zero.success).toBe(false)
    expect(six.success).toBe(false)
    expect(fractional.success).toBe(false)
  })

  it('rejects a motion value outside the enum', () => {
    const result = v.safeParse(clipSchema, { ...storedClipPayload, motion: 'glacial' })
    expect(result.success).toBe(false)
  })

  it('rejects a density value outside the enum', () => {
    const result = v.safeParse(clipSchema, { ...storedClipPayload, density: 'chunky' })
    expect(result.success).toBe(false)
  })

  it('rejects a layerHint value outside the enum', () => {
    const result = v.safeParse(clipSchema, { ...storedClipPayload, layerHint: 'mid' })
    expect(result.success).toBe(false)
  })

  it('requires a generator when origin is "generated"', () => {
    const withoutGenerator = v.safeParse(clipSchema, {
      ...storedClipPayload,
      origin: 'generated',
    })
    const withGenerator = v.safeParse(clipSchema, {
      ...storedClipPayload,
      generator: { at: 1_727_600_000_000, model: 'gpt-5', prompt: 'a slow kaleidoscope' },
      origin: 'generated',
    })
    expect(withoutGenerator.success).toBe(false)
    expect(withGenerator.success).toBe(true)
  })

  it('accepts each annotationStatus value', () => {
    const pending = v.safeParse(clipSchema, { ...storedClipPayload, annotationStatus: 'pending' })
    const ok = v.safeParse(clipSchema, { ...storedClipPayload, annotationStatus: 'ok' })
    const failed = v.safeParse(clipSchema, { ...storedClipPayload, annotationStatus: 'failed' })
    expect(pending.success).toBe(true)
    expect(ok.success).toBe(true)
    expect(failed.success).toBe(true)
  })

  it('rejects an annotationStatus value outside the enum', () => {
    const result = v.safeParse(clipSchema, { ...storedClipPayload, annotationStatus: 'annotating' })
    expect(result.success).toBe(false)
  })
})

describe('track creation payload', () => {
  it('accepts a minimal track payload', () => {
    const result = v.safeParse(newTrackSchema, minimalTrackPayload)
    expect(result.success).toBe(true)
  })

  it('rejects a payload carrying a client-supplied ownerId', () => {
    const result = v.safeParse(newTrackSchema, {
      ...minimalTrackPayload,
      ownerId: 'someone-elses-account',
    })
    expect(result.success).toBe(false)
  })
})
