// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest'

import type { ProbeResult } from './probe.ts'

// `probe.ts` imports `HydraCompositor` from `./compositor.ts`, which imports `hydra-synth` — a
// module that touches `window` at import time and so cannot load under this package's Node
// `vitest` environment (see `sentinel.ts`'s doc comment). This fake stands in for it: it runs the
// real `rewriteOut` exactly as `HydraCompositor.load` does, and models a slot's buffer as either
// freshly painted (when the rewritten code names that slot's own buffer, which — once past the
// multi-output refusal, which never reaches `load` at all — `rewriteOut` now always arranges) or
// left holding whatever it held before. Enough to drive `probeClip`'s sentinel logic honestly
// without a real GPU. Self-contained (everything it needs is imported inside the factory) because
// `vi.mock` factories run before the rest of this file's top-level bindings are initialised.
// oxlint-disable-next-line vitest/prefer-import-in-mock -- the factory dynamically imports instead, so its dependencies aren't evaluated before vi.mock's hoist
vi.mock('./compositor.ts', async () => {
  const { rewriteOut } = await import('./rewrite.ts')
  const { SENTINEL_CODE, SENTINEL_RGB } = await import('./sentinel.ts')

  const sentinelPixels = (): Uint8Array =>
    Uint8Array.from([...SENTINEL_RGB.map((fraction) => Math.round(fraction * 255)), 255])

  class FakeCompositor {
    private readonly pixelsBySlot = new Map<string, Uint8Array>()

    // Stands in for `HydraCompositor.mount`, whose only job is to create the real WebGL context
    // this fake has no need for.
    // oxlint-disable-next-line eslint/class-methods-use-this -- fake implements HydraCompositor's instance-method interface; this member is intentionally a no-op
    mount(): void {}

    load(slot: 'a' | 'b', code: string): void {
      const rewritten = rewriteOut(code, slot)
      const ownBuffer = slot === 'a' ? 'o1' : 'o2'
      if (new RegExp(`\\.out\\(\\s*${ownBuffer}\\s*\\)`, 'u').test(rewritten)) {
        this.pixelsBySlot.set(
          slot,
          code === SENTINEL_CODE ? sentinelPixels() : Uint8Array.from([10, 20, 30, 255]),
        )
      }
    }

    // oxlint-disable-next-line eslint/class-methods-use-this -- fake implements HydraCompositor's instance-method interface; this member is intentionally a no-op
    switchTo(): void {}

    // oxlint-disable-next-line eslint/class-methods-use-this -- fake implements HydraCompositor's instance-method interface; this member is intentionally a no-op
    tick(): void {}

    readSlotPixels(slot: 'a' | 'b'): Uint8Array {
      return this.pixelsBySlot.get(slot) ?? sentinelPixels()
    }

    // oxlint-disable-next-line eslint/class-methods-use-this -- fake implements HydraCompositor's instance-method interface; this member is intentionally a no-op
    dispose(): void {}
  }

  return { HydraCompositor: FakeCompositor }
})

const { probeClip } = await import('./probe.ts')

const asFailure = (result: ProbeResult): Extract<ProbeResult, { ok: false }> => {
  if (result.ok) {
    throw new Error('expected a failing ProbeResult')
  }
  return result
}

describe(probeClip, () => {
  it('rewrites a single named out() to the slot buffer, renders, and passes — the common pasted-Hydra shape', async () => {
    const canvas = {} as HTMLCanvasElement

    const result = await probeClip('osc(10).out(o0)', canvas)

    expect(result.ok).toBe(true)
  })

  it('rewrites a single out() naming a different buffer, renders, and passes — the case that used to throw', async () => {
    const canvas = {} as HTMLCanvasElement

    const result = await probeClip('noise().out(o3)', canvas)

    expect(result.ok).toBe(true)
  })

  it('appends an out() when the clip has none, and still passes', async () => {
    const canvas = {} as HTMLCanvasElement

    const result = await probeClip('osc(10)', canvas)

    expect(result.ok).toBe(true)
  })

  it('refuses two named out() calls with the multi-output reason and an actionable message', async () => {
    const canvas = {} as HTMLCanvasElement

    const result = await probeClip('osc(10).out(o1)\nnoise().out(o2)', canvas)

    const failure = asFailure(result)
    expect(failure.reason).toBe('multi-output')
    expect(failure.message).toMatch(/single .out\(/u)
  })

  it('refuses two bare out() calls with the multi-output reason too', async () => {
    const canvas = {} as HTMLCanvasElement

    const result = await probeClip('osc(10).out()\nnoise().out()', canvas)

    expect(asFailure(result).reason).toBe('multi-output')
  })
})
