// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'

import { analyzeHydra } from './hydra.ts'

describe(analyzeHydra, () => {
  it('reports every flag false for a clip that uses none of the detected features', () => {
    const deps = analyzeHydra('osc(10, 0.1, 1.2).kaleid(4).out()')
    expect(deps.usesFeedback).toBe(false)
    expect(deps.outputsUsed).toStrictEqual([])
    expect(deps.sourcesUsed).toStrictEqual([])
    expect(deps.usesAudio).toBe(false)
    expect(deps.extensions).toStrictEqual([])
  })

  it('is not isolated when it uses none of the detected features', () => {
    const deps = analyzeHydra('osc(10, 0.1, 1.2).kaleid(4).out()')
    expect(deps.isolated).toBe(false)
  })

  it('detects feedback from src(o0)', () => {
    const deps = analyzeHydra('src(o0).modulate(noise(3)).out(o1)')
    expect(deps.usesFeedback).toBe(true)
  })

  it('accumulates outputsUsed from .out(o1) and .out(o2)', () => {
    const deps = analyzeHydra('osc(10).out(o1)\nnoise(3).out(o2)')
    expect(deps.outputsUsed.toSorted()).toStrictEqual(['o1', 'o2'])
  })

  it('marks a clip isolated once it uses more than one output (spec §6.1)', () => {
    const deps = analyzeHydra('osc(10).out(o1)\nnoise(3).out(o2)')
    expect(deps.isolated).toBe(true)
  })

  it('does not mark a clip isolated when it uses a single output', () => {
    const deps = analyzeHydra('osc(10).out(o1)')
    expect(deps.isolated).toBe(false)
  })

  it('detects a camera source from s0.initCam()', () => {
    const deps = analyzeHydra('s0.initCam()\nsrc(s0).out(o1)')
    expect(deps.sourcesUsed).toStrictEqual(['cam'])
  })

  it('detects audio reactivity from a.fft', () => {
    const deps = analyzeHydra('osc(10).scale(() => 1 + a.fft[0]).out(o1)')
    expect(deps.usesAudio).toBe(true)
  })

  it('collects extensions loaded via loadScript', () => {
    const deps = analyzeHydra('loadScript("https://example.com/plugin.js")\nosc(10).out(o1)')
    expect(deps.extensions).toStrictEqual(['https://example.com/plugin.js'])
  })
})
