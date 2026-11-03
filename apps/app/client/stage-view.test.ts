// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'

import type { ControlSnapshot } from './control.ts'
import { createControl } from './control.ts'
import type { LiveView } from './live.ts'
import {
  cardBadge,
  creditLine,
  KEY_HELP,
  menuSections,
  NO_PANEL,
  registrationGate,
  stageNotices,
  switchEta,
  togglePanel,
} from './stage-view.ts'

const FADE = { bars: 2, kind: 'crossfade' } as const
const CLIPS = [
  { code: 'a()', id: 'a', title: 'A' },
  { code: 'b()', id: 'b', title: 'B' },
  { code: 'c()', id: 'c', title: 'C' },
]

const noop = (): void => {
  // Nothing to draw on.
}

/** Real control states, reached by playing, rather than snapshots assembled by hand. */
const rig = () => {
  let clock = 0
  const control = createControl(
    { load: noop, switchTo: noop, tick: noop },
    { clips: CLIPS, now: () => clock, startClipId: 'a' },
  )
  const advance = (to: number): void => {
    clock = to
    control.tick()
    control.tick()
  }
  const view = (candidates: readonly string[] = ['b', 'c']): LiveView =>
    ({
      control: control.getSnapshot(),
      live: {
        candidates: candidates.map((clipId) => ({ clipId, title: clipId.toUpperCase() })),
        load: 'ok',
      },
    }) as unknown as LiveView
  return { advance, control, view }
}

const snapshot = (overrides: Partial<ControlSnapshot>) => overrides as ControlSnapshot

describe(switchEta, () => {
  it('counts down to the bar an armed switch fires on', () => {
    const { advance, control } = rig()
    control.choose('b')
    advance(500)
    expect(switchEta(control.getSnapshot())).toBe('in 1.5s')
  })

  it('never reads below zero when a frame lands late', () => {
    expect(switchEta(snapshot({ firingAt: 100, now: 150, panic: 'none' }))).toBe('in 0.0s')
  })

  it('names the wait instead of a time that would only jump, during a fade or a freeze', () => {
    expect(switchEta(snapshot({ chosenClipId: 'b' }))).toBe('after the fade')
    expect(switchEta(snapshot({ firingAt: 2000, now: 0, panic: 'freeze' }))).toBe('after the freeze')
  })

  it('says nothing when no switch is coming', () => {
    const { control } = rig()
    expect(switchEta(control.getSnapshot())).toBeUndefined()
  })
})

describe(cardBadge, () => {
  it('outlines a chosen card with its countdown, and leaves the others alone', () => {
    const { control, view } = rig()
    control.choose('b')

    expect(cardBadge(view(), 'b')).toStrictEqual({ eta: 'in 2.0s', mark: 'chosen' })
    expect(cardBadge(view(), 'c')).toStrictEqual({ eta: undefined, mark: 'none' })
  })

  it('marks what Go would play differently from what will switch by itself', () => {
    const { control, view } = rig()
    control.stage('b')

    expect(cardBadge(view(), 'b')).toStrictEqual({ eta: undefined, mark: 'default' })
  })

  it('during a fade outlines the held choice, and names the clip fading in', () => {
    const { advance, control, view } = rig()
    control.setTransition(FADE)
    control.choose('b')
    advance(100)
    advance(2000)
    control.choose('c')

    expect(cardBadge(view(), 'b')).toStrictEqual({ eta: 'fading in', mark: 'landing' })
    expect(cardBadge(view(), 'c')).toStrictEqual({ eta: 'after the fade', mark: 'chosen' })
  })
})

describe('a card for the clip already on screen', () => {
  it('says it is playing, rather than ignoring the click', () => {
    const { view } = rig()
    expect(cardBadge(view(['a', 'b']), 'a')).toStrictEqual({ eta: 'playing', mark: 'playing' })
  })
})

describe(creditLine, () => {
  it('reads as §12.2 lays it out', () => {
    expect(creditLine('Drift', { author: 'Ana', license: 'CC BY 4.0', title: 'Drift' })).toBe(
      'Drift — Ana (CC BY 4.0)',
    )
  })

  it('shows a clip whose details have not arrived as such, rather than inventing them', () => {
    expect(creditLine('Quiet')).toBe('Quiet — author not loaded (licence not loaded)')
  })
})

describe(stageNotices, () => {
  it('is empty when nothing stands in the way, so the picture stays clear', () => {
    const { view } = rig()
    expect(stageNotices(view())).toStrictEqual([])
  })

  it('says a running fade is why the controls are dead', () => {
    const { advance, control, view } = rig()
    control.setTransition(FADE)
    control.choose('b')
    advance(100)
    advance(2000)

    expect(stageNotices(view()).map((notice) => notice.text)).toStrictEqual([
      'Fade in progress: Go, Back, the transition and track loading wait for it. Go now finishes it.',
    ])
  })

  it('names the armed clip, for when the cards are hidden', () => {
    const { control, view } = rig()
    control.choose('c')
    expect(stageNotices(view())[0]?.text).toBe('Next: C in 2.0s')
  })

  it('puts a picture fault first', () => {
    const { control, view } = rig()
    control.hold()
    expect(stageNotices(view(), 'The picture failed to start.')[0]).toStrictEqual({
      text: 'The picture failed to start.',
      tone: 'bad',
    })
  })
})

describe(registrationGate, () => {
  it('allows a probe when no switch is coming', () => {
    const { control } = rig()
    expect(registrationGate(control.getSnapshot())).toStrictEqual({ kind: 'allowed' })
  })

  it('refuses while a switch is armed, and says why', () => {
    const { control } = rig()
    control.choose('b')
    expect(registrationGate(control.getSnapshot())).toMatchObject({ kind: 'refused' })
  })

  it('refuses while a fade runs, and while a choice waits for it', () => {
    const { advance, control } = rig()
    control.setTransition(FADE)
    control.choose('b')
    advance(100)
    advance(2000)
    expect(registrationGate(control.getSnapshot())).toMatchObject({ kind: 'refused' })
    control.choose('c')
    expect(registrationGate(control.getSnapshot())).toMatchObject({ kind: 'refused' })
  })

  it('allows again once the switch has landed', () => {
    const { advance, control } = rig()
    control.choose('b')
    advance(100)
    advance(2000)
    expect(registrationGate(control.getSnapshot())).toStrictEqual({ kind: 'allowed' })
  })
})

describe(togglePanel, () => {
  it('opens what is asked for, replaces another panel, and closes itself', () => {
    expect(togglePanel(NO_PANEL, { kind: 'chat' })).toStrictEqual({ kind: 'chat' })
    expect(togglePanel({ kind: 'chat' }, { kind: 'library' })).toStrictEqual({ kind: 'library' })
    expect(togglePanel({ kind: 'library' }, { kind: 'library' })).toStrictEqual(NO_PANEL)
  })
})

const entry = (state: Parameters<typeof menuSections>[0], label: string) =>
  menuSections(state)
    .flatMap((section) => section.entries)
    .find((candidate) => candidate.label === label)

describe(menuSections, () => {
  const idle = {
    cardsShown: true,
    directed: false,
    fullscreen: false,
    overlays: { code: false, credit: false, keys: false, status: false },
    panel: NO_PANEL,
  }

  it('holds the panels, the overlays and Fullscreen, and nothing the transport row keeps', () => {
    const labels = menuSections(idle).flatMap((section) => section.entries.map((item) => item.label))
    expect(labels).toStrictEqual([
      'Playlist',
      'Library',
      'New clip',
      'Tracks',
      'Chat',
      'Cards',
      'Credit',
      'Code',
      'Now',
      'Keys',
      'Fullscreen',
    ])
  })

  it('says what is on and what is off, in words, beside every entry', () => {
    const state = {
      ...idle,
      fullscreen: true,
      overlays: { ...idle.overlays, status: true },
      panel: { kind: 'library' } as const,
    }
    expect(entry(state, 'Library')).toMatchObject({ on: true, state: 'open' })
    expect(entry(state, 'Playlist')).toMatchObject({ on: false, state: 'closed' })
    expect(entry(state, 'Now')).toMatchObject({ on: true, state: 'on' })
    expect(entry(state, 'Credit')).toMatchObject({ on: false, state: 'off' })
  })

  it('treats Cards and Fullscreen as toggles like the overlays', () => {
    const state = { ...idle, cardsShown: false, fullscreen: true }
    expect(entry(state, 'Cards')).toMatchObject({ on: false, state: 'off' })
    expect(entry(state, 'Fullscreen')).toMatchObject({ on: true, state: 'on' })
  })

  it('names the action each entry takes, so the template decides nothing', () => {
    expect(entry(idle, 'Tracks')?.action).toStrictEqual({ kind: 'panel', panel: 'tracks' })
    expect(entry(idle, 'Code')?.action).toStrictEqual({ id: 'code', kind: 'overlay' })
    expect(entry(idle, 'Cards')?.action).toStrictEqual({ kind: 'cards' })
    expect(entry(idle, 'Fullscreen')?.action).toStrictEqual({ kind: 'fullscreen' })
  })

  it('marks Chat when a direction is steering the show, because closing the panel does not end it', () => {
    expect(entry({ ...idle, directed: true }, 'Chat')).toMatchObject({ note: 'steering' })
    expect(entry(idle, 'Chat')?.note).toBeUndefined()
  })
})

describe('the key help', () => {
  it('says Esc closes the menu first', () => {
    const esc = KEY_HELP.find(([key]) => key === 'Esc')
    expect(esc?.[1]).toContain('menu')
  })
})
