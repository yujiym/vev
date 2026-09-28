// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Test fixtures for M1: two clips chosen to differ on brightness, density and motion,
 * so a cut reads as an event and a crossfade reads as a blend.
 *
 * These are fixtures, not library content. The example clips that ship to users live
 * in `examples/clips/` and arrive with M2, authored by the project's author — do not
 * move these there.
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
