// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Two clips chosen to differ on brightness, density and motion, so a cut reads as an event
 * and a crossfade reads as a blend. Written for M1, when they were the only thing that could
 * be put on screen.
 *
 * Still live, and deliberately so: M2 added the library and a track selector, and these are
 * what the control panel falls back to when the library is empty (`control.ts`'s default
 * `clips` and `startClipId`, and the panel's fixture buttons). Removing them would leave a
 * fresh install with nothing to press.
 *
 * They are fixtures, not library content — a registered clip is a D1 row, never one of these.
 * The example clips that ship to users (§18, M12) do not exist yet and will not live here.
 */
export const FIXTURES = [
  {
    code: 'osc(4, 0.05, 0.2).color(0.2, 0.3, 0.5).rotate(0.1).out()',
    id: 'quiet',
    title: 'Quiet — dark, slow, sparse',
  },
  {
    code: 'osc(40, 0.3, 2).kaleid(6).modulate(noise(4, 0.2)).contrast(1.6).out()',
    id: 'loud',
    title: 'Loud — bright, fast, dense',
  },
] as const
