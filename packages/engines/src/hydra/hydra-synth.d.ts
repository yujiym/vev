// SPDX-License-Identifier: AGPL-3.0-or-later
// `hydra-synth` ships no type declarations of its own; this is the minimal surface
// the compositor actually uses, established against the real 1.4.0 API (§17 spike).

declare module 'hydra-synth' {
  /** An opaque Hydra render target (`o0`..`o3`). Never introspected, only passed between calls. */
  export interface HydraOutput {
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

  export interface ReglInstance {
    destroy: () => void
  }

  export default class Hydra {
    constructor(options?: HydraOptions)
    readonly regl: ReglInstance
    readonly synth: HydraSynth
    tick: (dt: number) => void
  }
}
