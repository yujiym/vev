// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ControlSnapshot } from './control.ts'
import type { ClipMeta, LiveView } from './live.ts'

/**
 * What the stage's overlays say, as functions of what the control and the candidates hold. Decisions
 * live here rather than in the templates, which are outside the type and lint gate (ADR 0001).
 */

/** The info overlays. Each is off until its own button turns it on, so the picture normally has only buttons over it. */
export const OVERLAY_IDS = ['credit', 'code', 'status', 'keys'] as const
export type OverlayId = (typeof OVERLAY_IDS)[number]

export const OVERLAY_LABELS: Readonly<Record<OverlayId, string>> = {
  code: 'Code',
  credit: 'Credit',
  keys: 'Keys',
  status: 'Now',
}

export const KEY_HELP: readonly (readonly [string, string])[] = [
  ['1 2 3', 'choose a candidate: it switches on the next bar'],
  ['Space', 'Go: switch to what is staged on the next bar'],
  ['Shift+Space', 'Go now, or finish a running fade'],
  ['H', 'Hold'],
  ['B', 'Blackout'],
  ['Esc', 'close the menu, then the panel, or Freeze when neither is open'],
  ['C', 'open the steering chat'],
]

/** One panel at a time, and the track editor names its track. */
export type StagePanel =
  | { id: string; kind: 'track-editor' }
  | { kind: 'chat' | 'library' | 'new-clip' | 'none' | 'playlist' | 'tracks' }

export const NO_PANEL: StagePanel = { kind: 'none' }

export type PanelKind = 'chat' | 'library' | 'new-clip' | 'playlist' | 'tracks'

/** What choosing a menu entry does. The template only forwards it. */
export type MenuAction =
  | { id: OverlayId; kind: 'overlay' }
  | { kind: 'cards' }
  | { kind: 'fullscreen' }
  | { kind: 'panel'; panel: PanelKind }

export interface MenuEntry {
  action: MenuAction
  label: string
  /** Chat only: a standing direction keeps steering after its panel is closed. */
  note?: string
  on: boolean
  /** The state in words, so an entry reads the same without colour: `open`/`closed` for a panel, `on`/`off` for the rest. */
  state: 'closed' | 'off' | 'on' | 'open'
}

export interface MenuSection {
  entries: readonly MenuEntry[]
  title: string
}

export interface MenuInput {
  cardsShown: boolean
  /** A standing direction is steering the candidates. */
  directed: boolean
  fullscreen: boolean
  overlays: Readonly<Record<OverlayId, boolean>>
  panel: StagePanel
}

const MENU_PANELS: readonly { kind: PanelKind; label: string }[] = [
  { kind: 'playlist', label: 'Playlist' },
  { kind: 'library', label: 'Library' },
  { kind: 'new-clip', label: 'New clip' },
  { kind: 'tracks', label: 'Tracks' },
  { kind: 'chat', label: 'Chat' },
]

const toggle = (label: string, action: MenuAction, on: boolean): MenuEntry => ({
  action,
  label,
  on,
  state: on ? 'on' : 'off',
})

/**
 * Everything the control row does not keep: the panels, what is drawn over the picture, and
 * Fullscreen, each with its current state. The row holds only what a performer needs in the moment,
 * because the audience sees it; whatever is here is one click further away on purpose.
 */
export const menuSections = (input: MenuInput): readonly MenuSection[] => [
  {
    entries: MENU_PANELS.map(({ kind, label }): MenuEntry => {
      const on = input.panel.kind === kind
      const entry: MenuEntry = {
        action: { kind: 'panel', panel: kind },
        label,
        on,
        state: on ? 'open' : 'closed',
      }
      return kind === 'chat' && input.directed ? { ...entry, note: 'steering' } : entry
    }),
    title: 'Panels',
  },
  {
    entries: [
      toggle('Cards', { kind: 'cards' }, input.cardsShown),
      ...OVERLAY_IDS.map((id) => toggle(OVERLAY_LABELS[id], { id, kind: 'overlay' }, input.overlays[id])),
    ],
    title: 'On the picture',
  },
  { entries: [toggle('Fullscreen', { kind: 'fullscreen' }, input.fullscreen)], title: 'Window' },
]

/** The panel a button asks for: its own again closes it. */
export const togglePanel = (current: StagePanel, requested: StagePanel): StagePanel =>
  current.kind === requested.kind ? NO_PANEL : requested

/** When an armed or held switch happens, in words. `undefined` when none is coming. */
export const switchEta = (control: ControlSnapshot): string | undefined => {
  if (control.chosenClipId !== undefined) {
    return 'after the fade'
  }
  if (control.firingAt === undefined) {
    return undefined
  }
  if (control.panic === 'freeze') {
    return 'after the freeze'
  }
  const seconds = Math.max(0, (control.firingAt - control.now) / 1000)
  return `in ${seconds.toFixed(1)}s`
}

export type CardMark = 'chosen' | 'default' | 'landing' | 'none' | 'playing'

/**
 * What a candidate card shows about its clip. `chosen` is the outline: it will switch without
 * anything else being pressed. `default` is what Go would play. `landing` is the clip a fade is
 * bringing in, when a held choice has not taken over. `playing` is a stale answer offering the clip
 * already on screen, which cannot be chosen, so the card says so rather than ignoring the click.
 */
export const cardMark = (view: LiveView, clipId: string): CardMark => {
  const { control } = view
  if (control.chosenClipId === clipId) {
    return 'chosen'
  }
  if (control.current.clipId === clipId) {
    return 'playing'
  }
  if (control.next?.clipId !== clipId) {
    return 'none'
  }
  if (control.fading) {
    return 'landing'
  }
  return control.armed ? 'chosen' : 'default'
}

export interface CardBadge {
  mark: CardMark
  /** How long until this card's clip switches in, when it is going to. */
  eta: string | undefined
}

export const cardBadge = (view: LiveView, clipId: string): CardBadge => {
  const mark = cardMark(view, clipId)
  if (mark === 'landing') {
    return { eta: 'fading in', mark }
  }
  if (mark === 'playing') {
    return { eta: 'playing', mark }
  }
  return { eta: mark === 'chosen' ? switchEta(view.control) : undefined, mark }
}

/** §12.2 and §14.2: an unknown licence is shown as unknown, never left blank. */
export const creditLine = (title: string, clip?: ClipMeta): string =>
  `${title} — ${clip?.author ?? 'author not loaded'} (${clip?.license ?? 'licence not loaded'})`

export type NoticeTone = 'bad' | 'info' | 'warn'

export interface StageNotice {
  text: string
  tone: NoticeTone
}

/**
 * Anything standing in the performer's way, under the control row. Empty when all is well, which is
 * what keeps the picture clear. A disabled button also carries its reason in a tooltip, but a
 * tooltip does not explain a dead button at a glance, so a running fade is said out loud.
 */
export const stageNotices = (view: LiveView, pictureFault?: string): readonly StageNotice[] => {
  const { control, live } = view
  const notices: StageNotice[] = []
  const fault = pictureFault ?? control.pictureFault
  if (fault !== undefined) {
    notices.push({ text: fault, tone: 'bad' })
  }
  if (control.fading) {
    notices.push({
      text: 'Fade in progress: Go, Back, the transition and track loading wait for it. Go now finishes it.',
      tone: 'info',
    })
  }
  const eta = switchEta(control)
  if (eta !== undefined) {
    const clipId = control.chosenClipId ?? control.next?.clipId
    const title = live.candidates.find((candidate) => candidate.clipId === clipId)?.title ?? control.nextTitle
    notices.push({ text: `Next: ${title ?? clipId ?? 'clip'} ${eta}`, tone: 'info' })
  }
  if (control.held) {
    notices.push({ text: 'Hold is on: auto-advance is paused.', tone: 'warn' })
  }
  if (live.load === 'stale') {
    notices.push({
      text: `Candidates are stale, the show keeps playing: ${live.error ?? 'request failed'}`,
      tone: 'warn',
    })
  }
  return notices
}

export type RegistrationGate = { kind: 'allowed' } | { kind: 'refused'; reason: string }

/**
 * Whether a validation probe or thumbnail recording may start beside the live picture (ADR 0012).
 *
 * Both open a transient WebGL context on the show's GPU, and the probe compiles and reads pixels
 * synchronously on the show's thread, so each one can hitch the picture. A switch that is armed or
 * fading is the worst moment for a hitch, so it refuses then and says why. At any other time it runs
 * under the panel's standing warning: the screen cannot tell whether an audience is watching.
 */
export const registrationGate = (control: ControlSnapshot): RegistrationGate => {
  if (control.fading) {
    return {
      kind: 'refused',
      reason: 'A fade is running. A probe could make it stutter, so wait for it to land.',
    }
  }
  if (control.armed || control.chosenClipId !== undefined) {
    return {
      kind: 'refused',
      reason: 'A switch is armed. A probe could make it stutter, so wait for it to land.',
    }
  }
  return { kind: 'allowed' }
}
