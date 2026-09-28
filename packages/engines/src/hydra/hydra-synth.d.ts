// SPDX-License-Identifier: AGPL-3.0-or-later
// `hydra-synth` ships no type declarations of its own; this is the minimal surface
// the compositor actually uses, established against the real 1.4.0 API (§17 spike).

declare module 'hydra-synth' {
  /**
   * An opaque regl framebuffer — the ping-ponged render target behind one `HydraOutput`'s
   * `getCurrent()`. Never introspected, only passed to `ReglInstance.read()`; the unused optional
   * `never` field exists only so this is a distinct nominal type rather than a bare `object`.
   */
  export interface ReglFramebuffer {
    readonly __reglFramebuffer?: never
  }

  /** An opaque Hydra render target (`o0`..`o3`). Never introspected beyond `getCurrent()`. */
  export interface HydraOutput {
    /**
     * The framebuffer this output most recently rendered into (confirmed against the installed
     * 1.4.0 source, `src/output.js`: each output ping-pongs between two fbos, flipping which one
     * is "current" on every `.out()` draw call). Used by the validation probe's sentinel
     * technique (`probe.ts`) to read a slot's own buffer directly, bypassing the canvas — see
     * that module for why sampling the composed canvas instead gives the wrong answer.
     */
    getCurrent: () => ReglFramebuffer
    readonly label: string
  }

  /** A chainable Hydra source/transform expression, as produced by e.g. `osc()` or `src()`. */
  export interface HydraChain {
    blend: (other: HydraChain, amount?: number | (() => number)) => HydraChain
    out: (output?: HydraOutput) => void
  }

  export interface HydraOptions {
    autoLoop?: boolean
    canvas?: HTMLCanvasElement
    detectAudio?: boolean
    enableStreamCapture?: boolean
    height?: number
    makeGlobal?: boolean
    numOutputs?: number
    numSources?: number
    precision?: 'highp' | 'lowp' | 'mediump'
    width?: number
  }

  /**
   * The object clip code runs against: Hydra's generator functions (`osc`, `noise`,
   * `src`, ...), the four render targets `o0`..`o3`, and transport state. Untyped
   * beyond the members the compositor touches directly, since clip code reaches the
   * rest through `new Function` rather than through this type.
   */
  export interface HydraSynth {
    readonly o0: HydraOutput
    readonly o1: HydraOutput
    readonly o2: HydraOutput
    readonly o3: HydraOutput
    render: (output?: HydraOutput) => void
    src: (output: HydraOutput) => HydraChain
    // hydra-synth generates dozens of GLSL transform functions (`osc`, `noise`,
    // `kaleid`, ...) and mutable transport fields at construction time; there is no
    // static schema for them, which is exactly why clip code reaches them through
    // `new Function` (compositor.ts) rather than through typed access here.
    // oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
    [key: string]: unknown
  }

  /**
   * `destroy()` only clears regl's own bookkeeping (buffers, textures, event
   * listeners) — confirmed by reading regl 1.7.0's `dist/regl.js`: its `destroy`
   * never calls the `WEBGL_lose_context` extension. `_gl` is regl's own
   * documented escape hatch to the raw `WebGLRenderingContext`, needed to force
   * the context to actually release (compositor.ts's `dispose()`).
   */
  export interface ReglInstance {
    readonly _gl: WebGLRenderingContext
    destroy: () => void
    /**
     * Synchronously reads back RGBA pixels from `options.framebuffer` (confirmed against the
     * installed regl 1.7.0 source, `dist/regl.js`'s `readPixelsFBO`/`readPixelsImpl`) — a real
     * GPU sync, and the primitive the probe's sentinel technique reads a clip's own buffer with.
     */
    read: (options: { readonly framebuffer: ReglFramebuffer }) => Uint8Array
  }

  export default class Hydra {
    constructor(options?: HydraOptions)
    readonly regl: ReglInstance
    readonly synth: HydraSynth
    /**
     * Resizes the canvas's backing store and every output/source framebuffer to
     * match, then refreshes regl — confirmed against the installed 1.4.0 source
     * (`src/hydra-synth.js`'s `setResolution`, also bound onto `synth` itself).
     * This is the only correct way to resize a mounted instance: mutating
     * `canvas.width`/`height` directly leaves Hydra's framebuffers sized for the
     * old resolution.
     */
    setResolution: (width: number, height: number) => void
    tick: (dt: number) => void
  }
}
