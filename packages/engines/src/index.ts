// SPDX-License-Identifier: AGPL-3.0-or-later
export { barDurationMs, barPhase, bpmFromTaps, nextBarAt } from './clock.ts'
export type { Clock } from './clock.ts'
export { initialPlayback, reduce } from './playback.ts'
export type { PlaybackEvent, PlaybackState } from './playback.ts'
// Slot and TransitionSpec are @vev/shared's; they are not re-exported here, so there
// is one import path for them and no chance of two definitions drifting apart.
