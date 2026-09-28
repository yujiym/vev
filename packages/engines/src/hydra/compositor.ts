// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Slot, TransitionSpec } from '@vev/shared'
import Hydra from 'hydra-synth'
import type { HydraOutput, HydraSynth } from 'hydra-synth'

import type { Clock } from '../clock.ts'
import { fadeProgress } from '../transition.ts'
import { rewriteOut } from './rewrite.ts'

interface ActiveTransition {
  readonly fromSlot: Slot
  readonly spec: TransitionSpec
  readonly startedAt: number
  readonly toSlot: Slot
}

const bufferFor = (synth: HydraSynth, slot: Slot): HydraOutput => (slot === 'a' ? synth.o1 : synth.o2)

/**
 * The single Hydra instance that is both compositor and clip runtime (spec §6.1).
 *
 * `o1` and `o2` are the two clip buffers (slot a and slot b); `o0` is the
 * compositor's own output, which the canvas always shows — set once at `mount()`
 * and never reassigned again, so a transition only ever changes what feeds `o0`,
 * not which buffer is on screen. `o3` is left for clip code to use as scratch
 * (spec §6.1) and the compositor never touches it.
 *
 * Clip code is compiled with `new Function` over the synth's own keys as
 * parameter names, rather than through Hydra's own `eval()` (which calls
 * `globalThis.eval` internally — see hydra-synth's `src/lib/sandbox.js`) or a
 * plain module-scope `eval`. This is convenience and clarity, NOT a security
 * boundary: a `new Function` body still runs in global scope. It cannot see
 * `evalClip`'s local variables, but it can freely reach `window`, `document`,
 * `fetch` and everything else on the page — `new Function('a', 'return
 * globalThis.secret')('x')` proves this in one line. Binding the synth
 * functions as parameters only means a clip *need not* reach through globals
 * to draw; it does not stop a clip that chooses to anyway.
 *
 * Per spec §13/§11.2, that means only clips from the trusted library may run
 * here. Model-generated or otherwise untrusted clip code must go through the
 * real boundary — a sandboxed iframe on a separate origin (spec §13) — before
 * it ever reaches this class. `HydraCompositor` does not provide that boundary
 * and must not be treated as though it does.
 */
export class HydraCompositor {
  private readonly clock: Clock
  private hydra: Hydra | undefined
  private synth: HydraSynth | undefined
  private currentSlot: Slot = 'a'
  private transition: ActiveTransition | undefined
  private blendAmount = 0
  private lastTickAt: number | undefined

  constructor(clock: Clock) {
    this.clock = clock
  }

  /** Create the Hydra instance against `canvas` and point the canvas at the (empty) `o0`. */
  mount(canvas: HTMLCanvasElement): void {
    this.hydra = new Hydra({ autoLoop: false, canvas, detectAudio: false, makeGlobal: false })
    this.synth = this.hydra.synth
    this.synth.render(this.synth.o0)
    this.composeIdle()
  }

  /** Compile `code` into the slot's buffer (`o1` for `a`, `o2` for `b`), rewriting its bare `.out()`. */
  load(slot: Slot, code: string): void {
    this.evalClip(rewriteOut(code, slot))
  }

  /**
   * Begin showing `slot` as the current output, per `spec`.
   *
   * A cut swaps which buffer feeds `o0` outright — a plain recompile of `o0`'s
   * source, no blend pipeline involved. A crossfade instead wires `o0` to a
   * blend of the outgoing and incoming buffers, with the blend amount read from
   * a closure (`this.blendAmount`) that `tick()` updates every frame — this is
   * hydra-synth's normal mechanism for an animated uniform (see
   * `format-arguments.js`: a function argument is re-invoked once per frame).
   */
  switchTo(slot: Slot, spec: TransitionSpec, at: number): void {
    const synth = this.requireSynth()

    if (spec.kind === 'cut' || spec.bars <= 0) {
      this.currentSlot = slot
      this.transition = undefined
      this.composeIdle()
      return
    }

    this.transition = { fromSlot: this.currentSlot, spec, startedAt: at, toSlot: slot }
    this.currentSlot = slot
    this.blendAmount = 0

    const from = bufferFor(synth, this.transition.fromSlot)
    const to = bufferFor(synth, this.transition.toSlot)
    synth
      .src(from)
      .blend(synth.src(to), () => this.blendAmount)
      .out(synth.o0)
  }

  /** Advance the transition (if any) and the Hydra clock by the delta since the previous call. */
  tick(now: number): void {
    if (!this.hydra) {
      return
    }

    const dt = this.lastTickAt === undefined ? 0 : now - this.lastTickAt
    this.lastTickAt = now

    if (this.transition) {
      this.blendAmount = fadeProgress(this.transition.spec, this.transition.startedAt, now, this.clock)
      if (this.blendAmount >= 1) {
        this.composeIdle()
        this.transition = undefined
      }
    }

    this.hydra.tick(dt)
  }

  /**
   * Stop rendering and force the WebGL context to actually release.
   * `autoLoop: false` at construction means Hydra itself never started a
   * `requestAnimationFrame` loop — this instance is only ever advanced by an
   * external `tick()` call — so there is no internal loop to cancel.
   *
   * `regl.destroy()` alone is not enough: reading regl 1.7.0's own source shows
   * it only clears regl's bookkeeping (buffers, textures, event listeners) and
   * never calls the `WEBGL_lose_context` extension, so the context itself
   * survives until garbage collection — which the browser's context-count cap
   * (spec §6.5) does not wait for. `loseContext()` is the actual release;
   * `regl.destroy()` is called first so it isn't left operating on a context
   * that's already been told to go away.
   */
  dispose(): void {
    if (this.hydra) {
      const { _gl: gl, destroy } = this.hydra.regl
      destroy()
      gl.getExtension('WEBGL_lose_context')?.loseContext()
    }

    this.hydra = undefined
    this.synth = undefined
    this.transition = undefined
    this.lastTickAt = undefined
  }

  private composeIdle(): void {
    const synth = this.requireSynth()
    synth.src(bufferFor(synth, this.currentSlot)).out(synth.o0)
  }

  // Clip code is a user-authored Hydra sketch string (spec §6.1). `new Function`
  // over a fixed parameter list built from the synth's own keys binds those
  // functions as local parameters so a clip need not reach through globals to
  // draw — that is convenience and clarity, NOT sandboxing: the function body
  // still runs in global scope and can reach `window`, `document`, `fetch`, and
  // so on (see the class doc comment above). This is also why `instance.eval()`
  // is not used instead — it calls `globalThis.eval` (hydra-synth's
  // `src/lib/sandbox.js`), which is no different in this respect, just less
  // explicit about it. There is no non-evaluating way to run a runtime string of
  // arbitrary Hydra calls, so `new Function` here is a deliberate,
  // narrowly-scoped exception to the lint rules that otherwise ban dynamic code
  // execution — real isolation for untrusted clip code is a sandboxed iframe on
  // a separate origin (spec §13), upstream of this class, not inside it.
  private evalClip(code: string): void {
    const synth = this.requireSynth()
    const names = Object.keys(synth)
    const values = names.map((name) => synth[name])
    // oxlint-disable-next-line eslint/no-new-func, typescript/no-implied-eval
    const run = new Function(...names, code)
    // `run` is exactly what `new Function` above says it is: a function built from
    // `names` and `code`, invoked with the matching `values`.
    // oxlint-disable-next-line typescript/no-unsafe-call
    run(...values)
  }

  private requireSynth(): HydraSynth {
    if (!this.synth) {
      throw new Error('HydraCompositor: mount() must be called before use.')
    }
    return this.synth
  }
}
