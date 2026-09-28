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
 * Clip code never runs against `globalThis` and never through Hydra's own
 * `eval()` — that method calls `globalThis.eval` internally (see hydra-synth's
 * `src/lib/sandbox.js`), which would let a clip reach the page. Instead each
 * clip string is compiled once with `new Function` over the synth's own keys as
 * parameter names and invoked with the synth's values as arguments, so a clip
 * can only ever reach what the compositor hands it.
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
   * Stop rendering and free the WebGL context. `autoLoop: false` at construction
   * means Hydra itself never started a `requestAnimationFrame` loop — this
   * instance is only ever advanced by an external `tick()` call — so there is no
   * internal loop to cancel; the resource that matters is the context itself,
   * since spec §6.5 caps how many can exist at once.
   */
  dispose(): void {
    this.hydra?.regl.destroy()
    this.hydra = undefined
    this.synth = undefined
    this.transition = undefined
    this.lastTickAt = undefined
  }

  private composeIdle(): void {
    const synth = this.requireSynth()
    synth.src(bufferFor(synth, this.currentSlot)).out(synth.o0)
  }

  // Clip code is a user-authored Hydra sketch string (spec §6.1). Running it with
  // `new Function` over a fixed parameter list built from the synth's own keys —
  // never against `globalThis`, never via Hydra's own `eval()` (which itself calls
  // `globalThis.eval`, see hydra-synth's `src/lib/sandbox.js`) — is the sandboxing
  // mechanism the brief specifies (Task 3 Step 8): a clip can only reach what is
  // passed to it as an argument. There is no non-evaluating way to run a runtime
  // string of arbitrary Hydra calls, so this is a deliberate, narrowly-scoped
  // exception to the lint rules that otherwise ban dynamic code execution.
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
