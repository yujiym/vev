// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Clock } from '@vev/engines'
import type { Slot, TransitionSpec } from '@vev/shared'

/**
 * The subset of `HydraCompositor` the browser code drives. Declared here, not imported from
 * `@vev/engines/hydra`, so nothing touches `hydra-synth` or `window` at import time and a fake
 * satisfying this interface is all a test needs.
 */
export interface Compositor {
  dispose: () => void
  load: (slot: Slot, code: string) => void
  mount: (canvas: HTMLCanvasElement) => void
  resize: (width: number, height: number) => void
  switchTo: (slot: Slot, spec: TransitionSpec, at: number) => void
  tick: (now: number) => void
}

/** Dynamic, never static: that subpath touches `window` at load, and must stay out of the Worker bundle (§3). */
export const createHydraCompositor = async (clock: Clock): Promise<Compositor> => {
  const { HydraCompositor } = await import('@vev/engines/hydra')
  return new HydraCompositor(clock)
}
