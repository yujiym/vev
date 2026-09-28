// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest'

import type { ProbeResult } from './probe.ts'

/**
 * What a test writes into a clip's code to tell the fake compositor below how to behave. Block
 * comments, so `rewriteOut`'s scanner skips them and the code still counts as exactly the `.out(`
 * calls the test intends.
 */
const MARKERS = {
  /**
   * The probe's own sentinel fill reads back as something else — a WebGL/environment fault, not a
   * fact about the clip. This one is a property on the CANVAS, not a marker in the code: the
   * sentinel is filled and confirmed before `probeClip` ever hands the fake the clip's code, so
   * the canvas the caller passes to `mount` is the only channel that exists that early.
   */
  breaksTheSentinel: 'fakeBreaksTheSentinel',
  /** The slowest probed frame costs this many real milliseconds. A LITERAL number belongs at each call site, never `FRAME_BUDGET_MS + n`: a test written relative to the constant follows the constant when it is mutated, and then proves nothing about the gate. */
  costsMs: /\/\* fake: costs (?<ms>\d+)ms \*\//u,
  /** The clip loads and runs but never writes its own buffer. */
  rendersNothing: '/* fake: renders nothing */',
  /** The clip fails to compile — `load` throws, as Hydra's `eval` of a broken sketch does. */
  throwsOnLoad: '/* fake: throws on load */',
  /** The clip compiles but blows up when it is switched in. */
  throwsOnSwitch: '/* fake: throws on switchTo */',
}

// `probe.ts` imports `HydraCompositor` from `./compositor.ts`, which imports `hydra-synth` — a
// module that touches `window` at import time and so cannot load under this package's Node
// `vitest` environment (see `sentinel.ts`'s doc comment). This fake stands in for it: it runs the
// real `rewriteOut` exactly as `HydraCompositor.load` does, and models a slot's buffer as either
// freshly painted (when the rewritten code names that slot's own buffer, which — once past the
// multi-output refusal, which never reaches `load` at all — `rewriteOut` now always arranges) or
// left holding whatever it held before. Enough to drive `probeClip`'s sentinel logic honestly
// without a real GPU.
//
// **It can also fail.** A fake that always paints, never throws and costs no time leaves four of
// `probeClip`'s five refusals — black-frame, budget-exceeded, compile-error and render-error —
// structurally untestable, which is how deleting the black-frame branch and defanging the budget
// comparison both left the whole suite green. It therefore reads four markers out of the clip
// code it is handed (`MARKERS` below) and does what they say. The marker travels in the code
// because that is the one channel a `vi.mock` factory and a test body already share: a control
// object exported alongside `HydraCompositor` would not exist on the real module's type, and
// `pnpm check` type-checks this file. Every marker is a block comment, which `rewriteOut`'s
// scanner skips, so a marker never changes what the code under test counts as an `.out(` call.
//
// Its module imports stay inside the factory: `vi.mock` hoists this call above every `import` in
// the file, so a top-level `import { rewriteOut }` would not be initialised when the hoisted call
// is evaluated. `MARKERS` is different and is deliberately read from the outer scope — the factory
// is not RUN at hoist time, only registered; it runs on the first import of `./compositor.ts`,
// which is the `await import('./probe.ts')` below, by which point `MARKERS` is initialised.
// oxlint-disable-next-line vitest/prefer-import-in-mock -- the factory dynamically imports instead, so its dependencies aren't evaluated before vi.mock's hoist
vi.mock('./compositor.ts', async () => {
  const { rewriteOut } = await import('./rewrite.ts')
  const { SENTINEL_CODE, SENTINEL_RGB } = await import('./sentinel.ts')

  const sentinelPixels = (): Uint8Array =>
    Uint8Array.from([...SENTINEL_RGB.map((fraction) => Math.round(fraction * 255)), 255])

  class FakeCompositor {
    private breaksTheSentinel = false
    private costMs = 0
    private readonly pixelsBySlot = new Map<string, Uint8Array>()
    private throwsOnSwitch = false

    // Stands in for `HydraCompositor.mount`, whose only job is to create the real WebGL context
    // this fake has no need for — except as the one channel that exists before any clip code does
    // (see `MARKERS.breaksTheSentinel`).
    mount(canvas: HTMLCanvasElement): void {
      this.breaksTheSentinel = MARKERS.breaksTheSentinel in canvas
    }

    load(slot: 'a' | 'b', code: string): void {
      if (code.includes(MARKERS.throwsOnLoad)) {
        // Shaped like what Hydra's own `eval` of a broken sketch throws — the text `probeClip`
        // must carry out to the registrant rather than discard.
        throw new SyntaxError("Unexpected token ')'")
      }

      this.throwsOnSwitch = code.includes(MARKERS.throwsOnSwitch)
      this.costMs = Number(MARKERS.costsMs.exec(code)?.groups?.ms ?? 0)

      if (code.includes(MARKERS.rendersNothing)) {
        // The clip loaded and will run; it simply never writes its own buffer — which leaves the
        // sentinel fill in place, exactly as a clip whose chain renders nothing does.
        return
      }

      const rewritten = rewriteOut(code, slot)
      const ownBuffer = slot === 'a' ? 'o1' : 'o2'
      if (new RegExp(`\\.out\\(\\s*${ownBuffer}\\s*\\)`, 'u').test(rewritten)) {
        const painted =
          code === SENTINEL_CODE && this.breaksTheSentinel
            ? Uint8Array.from([0, 0, 0, 255])
            : Uint8Array.from([10, 20, 30, 255])
        this.pixelsBySlot.set(
          slot,
          code === SENTINEL_CODE && !this.breaksTheSentinel ? sentinelPixels() : painted,
        )
      }
    }

    switchTo(): void {
      if (this.throwsOnSwitch) {
        throw new Error('regl: cannot read property of undefined')
      }
    }

    tick(): void {
      if (this.costMs <= 0) {
        return
      }
      // Real wall clock, because `probeClip` times itself with `performance.now()` around a call
      // it makes for real. One expensive frame is enough: the probe keeps the MAXIMUM.
      const until = performance.now() + this.costMs
      this.costMs = 0
      let spins = 0
      while (performance.now() < until) {
        spins += 1
      }
      void spins
    }

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

  // The four below are the refusals this suite could not previously express at all. Each one goes
  // red if its gate is deleted or defanged — verified by applying those mutations, not assumed.

  it('refuses a clip that loads and runs but writes nothing to its own buffer', async () => {
    const canvas = {} as HTMLCanvasElement

    const result = await probeClip(`osc(10)${MARKERS.rendersNothing}`, canvas)

    const failure = asFailure(result)
    expect(failure.reason).toBe('black-frame')
    expect(failure.message).toMatch(/wrote nothing/u)
  })

  it('passes a clip that DOES write its own buffer, so the black-frame gate is not simply "refuse everything"', async () => {
    const canvas = {} as HTMLCanvasElement

    const result = await probeClip('solid(0, 0, 0).out()', canvas)

    expect(result.ok).toBe(true)
  })

  // 60 is a literal, deliberately: written as `FRAME_BUDGET_MS + 10` this test would follow the
  // constant wherever a mutation moved it and could never notice the budget being switched off.
  it('refuses a clip whose slowest probed frame costs more than the 50ms frame budget', async () => {
    const canvas = {} as HTMLCanvasElement

    const result = await probeClip('osc(10)/* fake: costs 60ms */', canvas)

    const failure = asFailure(result)
    expect(failure.reason).toBe('budget-exceeded')
    expect(failure.maxFrameMs).toBeGreaterThan(50)
    // The measured number reaches the screen, not just the verdict.
    expect(failure.message).toMatch(/\d+\.\dms, over the 50ms budget/u)
  })

  it('reports compile-error, and keeps the JavaScript error the clip threw', async () => {
    const canvas = {} as HTMLCanvasElement

    const result = await probeClip(`osc(10)${MARKERS.throwsOnLoad}`, canvas)

    const failure = asFailure(result)
    expect(failure.reason).toBe('compile-error')
    expect(failure.error).toBeInstanceOf(SyntaxError)
    // The most actionable refusal of the five: the author can fix a syntax error if told what it
    // is, and the registration page shows `message`.
    expect(failure.message).toContain("Unexpected token ')'")
  })

  it('reports render-error when the clip compiles but blows up on the way in', async () => {
    const canvas = {} as HTMLCanvasElement

    const result = await probeClip(`osc(10)${MARKERS.throwsOnSwitch}`, canvas)

    const failure = asFailure(result)
    expect(failure.reason).toBe('render-error')
    expect(failure.message).toContain('regl: cannot read property of undefined')
  })

  it('says the reference frame failed, not the clip, when the probe itself could not paint', async () => {
    const canvas = { [MARKERS.breaksTheSentinel]: true } as unknown as HTMLCanvasElement

    // The sentinel fill is the probe's own setup, so a failure there says nothing about the clip.
    const result = await probeClip('solid(1, 1, 1)', canvas)

    const failure = asFailure(result)
    expect(failure.reason).toBe('render-error')
    expect(failure.message).toMatch(/nothing about this clip was tested/u)
  })
})
