// SPDX-License-Identifier: AGPL-3.0-or-later
import type { KeyTarget } from './live.ts'

/** The browser calls the stage makes that have no logic worth a fake: the drivers exercise them. */

/** What Chromium's Keyboard Lock adds to `navigator`; it is not in TypeScript's DOM lib. */
interface WithKeyboardLock {
  keyboard?: { lock: (codes: readonly string[]) => Promise<void>; unlock: () => void }
}

const hasKeyboardLock = (nav: Navigator): nav is Navigator & WithKeyboardLock => 'keyboard' in nav

const keyboardLock = (): WithKeyboardLock['keyboard'] =>
  hasKeyboardLock(navigator) ? navigator.keyboard : undefined

/**
 * Browser fullscreen spends `Esc` on leaving fullscreen, and `Esc` is the Freeze key. Keyboard Lock
 * gives it back in Chromium; holding `Esc` still leaves. Where it is missing, `Esc` leaves
 * fullscreen and the Freeze button is the way to freeze.
 */
export const toggleFullscreen = async (): Promise<void> => {
  if (document.fullscreenElement !== null) {
    keyboardLock()?.unlock()
    await document.exitFullscreen()
    return
  }

  await document.documentElement.requestFullscreen()
  await keyboardLock()?.lock(['Escape'])
}

export const watchFullscreen = (onChange: (isFullscreen: boolean) => void): (() => void) => {
  const listener = (): void => {
    onChange(document.fullscreenElement !== null)
  }
  document.addEventListener('fullscreenchange', listener)
  return () => {
    document.removeEventListener('fullscreenchange', listener)
  }
}

/** A reload forgets the track and the direction (ADR 0012), so a stray F5 has to be confirmed. */
const askBeforeLeaving = (event: BeforeUnloadEvent): void => {
  event.preventDefault()
}

export const guardReload = (): (() => void) => {
  window.addEventListener('beforeunload', askBeforeLeaving)
  return () => {
    window.removeEventListener('beforeunload', askBeforeLeaving)
  }
}

/** A play interrupted by the pointer leaving again is not a failure: the first frame is still showing. */
export const playThumbnail = async (video: HTMLVideoElement): Promise<void> => {
  try {
    await video.play()
  } catch (error) {
    console.debug('vev: a thumbnail did not play', error)
  }
}

export const keyTargetOf = (target: EventTarget | null): KeyTarget | undefined =>
  target instanceof HTMLElement
    ? {
        inPanel: target.closest('aside') !== null,
        isContentEditable: target.isContentEditable,
        tagName: target.tagName,
      }
    : undefined

/** Whether a pointer landed on the menu or its button, so a click anywhere else on the stage closes it. */
export const insideMenu = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest('[data-menu-root]') !== null
