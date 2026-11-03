<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { Control } from '../control.ts'
  import { controlHints } from '../control.ts'
  import type { Live, LiveView } from '../live.ts'
  import { nextTransitionChoice, transitionLabel } from '../live.ts'
  import type { MenuAction, MenuSection } from '../stage-view.ts'
  import { insideMenu } from '../stage-window.ts'

  interface Props {
    control: Control | undefined
    live: Live | undefined
    menuOpen: boolean
    onMenu: () => void
    onMenuChoose: (action: MenuAction) => void
    sections: readonly MenuSection[]
    view: LiveView | undefined
  }

  const { control, live, menuOpen, onMenu, onMenuChoose, sections, view }: Props = $props()

  const hints = $derived(view === undefined ? undefined : controlHints(view.control))
  const snapshot = $derived(view?.control)
  const panic = $derived(snapshot?.panic ?? 'none')
  const decision = $derived(view?.live.decision)
  const transition = $derived(view?.live.next?.transition ?? snapshot?.transition)
  const directed = $derived(view?.live.direction !== undefined)
  const menuTitle = $derived(
    sections
      .flatMap((section) => section.entries)
      .filter((entry) => entry.on)
      .map((entry) => entry.label)
      .join(', '),
  )
</script>

<svelte:window
  onpointerdown={(event) => {
    if (menuOpen && !insideMenu(event.target)) {
      onMenu()
    }
  }}
/>

<header class="row">
  <div class="group">
    <button
      aria-pressed={snapshot?.held ?? false}
      class:active={snapshot?.held}
      onclick={() => control?.hold()}
      type="button">Hold</button
    >
    <button disabled={!snapshot?.canBack} onclick={() => control?.back()} title={hints?.back} type="button"
      >Back</button
    >
    <button disabled={!snapshot?.canGo} onclick={() => control?.go()} title={hints?.go} type="button"
      >Go</button
    >
    <button disabled={!snapshot?.canGoNow} onclick={() => control?.goNow()} type="button">Go now</button>
    <button
      class="transition"
      disabled={!snapshot?.canSetTransition || transition === undefined}
      onclick={() => {
        if (transition !== undefined) {
          live?.chooseTransition(nextTransitionChoice(transition))
        }
      }}
      title={hints?.transition ?? `${view?.live.next?.transitionFrom ?? 'next switch'}: click to change`}
      type="button">{transition === undefined ? 'Transition' : transitionLabel(transition)}</button
    >
  </div>

  <div class="group panic">
    <button
      aria-pressed={panic === 'blackout'}
      class:active={panic === 'blackout'}
      onclick={() => control?.blackout()}
      type="button">Blackout</button
    >
    <button
      aria-pressed={panic === 'freeze'}
      class:active={panic === 'freeze'}
      onclick={() => control?.freeze()}
      type="button">Freeze</button
    >
  </div>

  <div class="group">
    <span class="readout bpm">{snapshot ? Math.round(snapshot.bpm) : '—'} BPM</span>
    <button onclick={() => control?.tap()} type="button">TAP</button>
    <button
      aria-pressed={snapshot?.track?.autoAdvance ?? false}
      class:active={snapshot?.track?.autoAdvance}
      disabled={snapshot?.track === undefined}
      onclick={() => control?.setAutoAdvance(!snapshot?.track?.autoAdvance)}
      title={snapshot?.track === undefined ? 'Load a track for auto-advance.' : undefined}
      type="button">Auto</button
    >
    <span
      class="readout decision"
      class:ok={decision?.tone === 'decision'}
      class:warn={decision?.tone === 'fallback'}
      class:bad={decision?.tone === 'stale'}
    >
      <span class="dot" aria-hidden="true"></span>{decision?.label ?? 'starting…'}
    </span>
  </div>

  <div class="group menu-root" data-menu-root>
    <button
      aria-expanded={menuOpen}
      aria-haspopup="menu"
      class:active={menuOpen}
      class:directed
      onclick={onMenu}
      title={menuTitle === '' ? 'Panels, overlays and Fullscreen' : `On now: ${menuTitle}`}
      type="button">Menu</button
    >
    {#if menuOpen}
      <div aria-label="Menu" class="menu" role="menu">
        {#each sections as section (section.title)}
          <div aria-label={section.title} role="group">
            <span class="menu-title">{section.title}</span>
            {#each section.entries as entry (entry.label)}
              <button
                aria-checked={entry.on}
                class:on={entry.on}
                data-menu={entry.label}
                onclick={() => onMenuChoose(entry.action)}
                role="menuitemcheckbox"
                type="button"
              >
                <span class="entry-label">{entry.label}</span>
                {#if entry.note}<span class="note">{entry.note}</span>{/if}
                <span class="entry-state">{entry.state}</span>
              </button>
            {/each}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</header>

<style>
  /* The row itself is see-through and clicks fall through it: only the buttons sit on the picture. */
  .row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.6rem;
    padding: 0.3rem 0.4rem;
    pointer-events: none;
  }

  .group {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 0.2rem;
  }

  /* Near-opaque: the row sits on whatever the clip draws, and over white a see-through button lets it grey out. */
  button,
  .readout {
    background: rgb(8 10 14 / 92%);
    border: 1px solid rgb(255 255 255 / 34%);
    border-radius: 0.28rem;
    color: #f4f6fa;
    font: inherit;
    font-size: 0.68rem;
    font-weight: 600;
    line-height: 1.2;
    padding: 0.18rem 0.42rem;
    pointer-events: auto;
    white-space: nowrap;
  }

  button {
    cursor: pointer;
  }

  button:hover:not(:disabled) {
    background: rgb(40 46 60 / 92%);
  }

  /* Disabled is dimmer in its border and its weight, not in its text, which has to stay readable over a bright picture. */
  button:disabled {
    border-color: rgb(255 255 255 / 20%);
    color: #b4bcc9;
    cursor: not-allowed;
    font-weight: 500;
  }

  button.active {
    background: rgb(20 66 54 / 92%);
    border-color: #6ef2c0;
    color: #c9ffec;
  }

  .panic button {
    border-color: rgb(255 130 130 / 70%);
  }

  .panic button.active {
    background: rgb(120 20 30 / 95%);
    border-color: #ff8a8a;
    color: #fff;
  }

  .directed {
    border-color: #ffb454;
  }

  .readout {
    align-items: center;
    display: inline-flex;
    gap: 0.25rem;
    pointer-events: none;
  }

  .bpm {
    font-family: ui-monospace, monospace;
    font-variant-numeric: tabular-nums;
  }

  .dot {
    background: #9aa3b2;
    border-radius: 50%;
    height: 0.45rem;
    width: 0.45rem;
  }

  .ok .dot {
    background: #6ef2c0;
  }

  .warn .dot {
    background: #ffb454;
  }

  .bad .dot {
    background: #ff6470;
  }

  .menu-root {
    position: relative;
  }

  /* Below the row, never over it: Blackout and Freeze stay one click away with the menu open. */
  .menu {
    background: rgb(10 12 16 / 96%);
    border: 1px solid rgb(255 255 255 / 34%);
    border-radius: 0.35rem;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    min-width: 13rem;
    padding: 0.4rem;
    pointer-events: auto;
    position: absolute;
    right: 0;
    top: calc(100% + 0.25rem);
    z-index: 40;
  }

  .menu > [role='group'] {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }

  .menu-title {
    color: #b4bcc9;
    font-size: 0.6rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .menu button {
    align-items: baseline;
    display: flex;
    gap: 0.5rem;
    justify-content: space-between;
    text-align: left;
  }

  .entry-label {
    flex: 1;
  }

  .note {
    color: #ffb454;
    font-weight: 500;
  }

  .entry-state {
    color: #b4bcc9;
    font-weight: 500;
  }

  .menu button.on .entry-state {
    color: #6ef2c0;
    font-weight: 700;
  }
</style>
