// SPDX-License-Identifier: AGPL-3.0-or-later
import * as v from 'valibot'

import type { ControlSnapshot } from './control.ts'

/**
 * What survives a reload of the stage (ADR 0012, spec §17): the clip on screen, the tempo and its bar
 * grid, and a blackout. Those are what an audience would notice jumping. Everything else restarts:
 * the track and its position, candidates, the direction and the history.
 *
 * Freeze does not survive, because the frame it held is gone with the canvas. `sessionStorage` is
 * this tab's, so a new tab starts clean.
 */
const STORAGE_KEY = 'vev:show'

const showMemorySchema = v.object({
  beatsPerBar: v.pipe(v.number(), v.integer(), v.minValue(1)),
  blackout: v.boolean(),
  bpm: v.pipe(v.number(), v.finite(), v.minValue(1)),
  clipId: v.pipe(v.string(), v.minLength(1)),
  downbeatAt: v.number(),
})

export type ShowMemory = v.InferOutput<typeof showMemorySchema>

/** The storage calls this module makes. A browser's `Storage` satisfies it. */
export interface MemoryStorage {
  getItem: (key: string) => string | null
  setItem: (key: string, value: string) => void
}

/** Anything unreadable is no memory at all: a reload must never fail on what the last one left. */
export const readShowMemory = (storage: MemoryStorage): ShowMemory | undefined => {
  try {
    const stored = storage.getItem(STORAGE_KEY)
    return stored === null ? undefined : v.parse(showMemorySchema, JSON.parse(stored))
  } catch (error) {
    console.error('vev: ignoring an unreadable show memory', error)
    return undefined
  }
}

export const showMemoryOf = (control: ControlSnapshot, downbeatAt: number): ShowMemory => ({
  beatsPerBar: control.beatsPerBar,
  blackout: control.panic === 'blackout',
  bpm: control.bpm,
  clipId: control.current.clipId,
  downbeatAt,
})

/** Writes only what changed, since the control notifies many times a second. A full or blocked store costs the memory, not the show. */
export const createShowMemoryWriter = (storage: MemoryStorage): ((memory: ShowMemory) => void) => {
  let written: string | undefined
  return (memory) => {
    const serialized = JSON.stringify(memory)
    if (serialized === written) {
      return
    }
    written = serialized
    try {
      storage.setItem(STORAGE_KEY, serialized)
    } catch (error) {
      console.error('vev: could not store the show memory', error)
    }
  }
}
