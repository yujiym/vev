// SPDX-License-Identifier: AGPL-3.0-or-later
// Separate entry point from the package root (`@vev/engines/hydra`, see the
// package's `exports` map): this file — and everything it imports — pulls in
// `hydra-synth`, which touches `window` at module load time and so can only ever
// be imported by browser code, in practice only the output window (spec §3).
export { HydraCompositor } from './compositor.ts'
export type { ProbeFailureReason, ProbeResult } from './probe.ts'
export { hasFrameVariance, probeClip } from './probe.ts'
