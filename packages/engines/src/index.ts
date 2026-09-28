// SPDX-License-Identifier: AGPL-3.0-or-later
// Pure logic only — no browser dependency, safe to import from Node (tests, the
// control window, anywhere else). The compositor is a separate entry point,
// `@vev/engines/hydra`, because it pulls in `hydra-synth`, which touches `window`
// at module load time and must never end up in a bundle that isn't the output
// window's (spec §3: only the output window renders).
export { barDurationMs, barPhase, bpmFromTaps, nextBarAt } from './clock.ts'
export type { Clock } from './clock.ts'
export { FIXTURES } from './fixtures.ts'
// `rewriteOut` and its siblings live under `hydra/` but belong to this pure entry, not to
// `@vev/engines/hydra`: they are string transforms over clip source with no renderer behind them,
// and `@vev/ingest` and `apps/api` both need them in a Worker, where `hydra-synth` cannot go.
export { countOutCalls, MULTI_OUTPUT_MESSAGE, outCallTargets, rewriteOut } from './hydra/rewrite.ts'
export { canGo, canGoNow, canQueue, canSetTransition, initialPlayback, reduce } from './playback.ts'
export type { PlaybackEvent, PlaybackState } from './playback.ts'
export { fadeProgress } from './transition.ts'
// Slot and TransitionSpec are @vev/shared's; they are not re-exported here, so there
// is one import path for them and no chance of two definitions drifting apart.
