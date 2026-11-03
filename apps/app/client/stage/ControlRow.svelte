<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { Control } from '../control.ts'
  import { controlHints } from '../control.ts'
  import type { Live, LiveView } from '../live.ts'
  import { nextTransitionChoice, transitionLabel } from '../live.ts'
  import type { OverlayId, StagePanel } from '../stage-view.ts'
  import { OVERLAY_IDS, OVERLAY_LABELS } from '../stage-view.ts'

  interface Props {
    cardsShown: boolean
    control: Control | undefined
    fullscreen: boolean
    live: Live | undefined
    onFullscreen: () => void
    onPanel: (panel: StagePanel) => void
    onToggleCards: () => void
    onToggleOverlay: (id: OverlayId) => void
    overlays: Readonly<Record<OverlayId, boolean>>
    panel: StagePanel
    view: LiveView | undefined
  }

  const {
    cardsShown,
    control,
    fullscreen,
    live,
    onFullscreen,
    onPanel,
    onToggleCards,
    onToggleOverlay,
    overlays,
    panel,
    view,
  }: Props = $props()

  const hints = $derived(view === undefined ? undefined : controlHints(view.control))
  const snapshot = $derived(view?.control)
  const panic = $derived(snapshot?.panic ?? 'none')
  const decision = $derived(view?.live.decision)
  const transition = $derived(view?.live.next?.transition ?? snapshot?.transition)
  const direction = $derived(view?.live.direction)

  const PANELS: readonly { kind: 'chat' | 'library' | 'new-clip' | 'playlist' | 'tracks'; label: string }[] =
    [
      { kind: 'playlist', label: 'Playlist' },
      { kind: 'library', label: 'Library' },
      { kind: 'new-clip', label: 'New clip' },
      { kind: 'tracks', label: 'Tracks' },
      { kind: 'chat', label: 'Chat' },
    ]
</script>

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

  <div class="group">
    {#each PANELS as entry (entry.kind)}
      <button
        aria-pressed={panel.kind === entry.kind}
        class:active={panel.kind === entry.kind}
        class:directed={entry.kind === 'chat' && direction !== undefined}
        onclick={() => onPanel({ kind: entry.kind })}
        type="button">{entry.label}</button
      >
    {/each}
  </div>

  <div class="group">
    <button aria-pressed={cardsShown} class:active={cardsShown} onclick={onToggleCards} type="button"
      >Cards</button
    >
    {#each OVERLAY_IDS as id (id)}
      <button
        aria-pressed={overlays[id]}
        class:active={overlays[id]}
        onclick={() => onToggleOverlay(id)}
        type="button">{OVERLAY_LABELS[id]}</button
      >
    {/each}
    <button aria-pressed={fullscreen} class:active={fullscreen} onclick={onFullscreen} type="button"
      >Fullscreen</button
    >
  </div>
</header>

<style>
  /* The row itself is see-through and clicks fall through it: only the buttons sit on the picture. */
  .row {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem 0.6rem;
    left: 0;
    padding: 0.3rem 0.4rem;
    pointer-events: none;
    position: fixed;
    right: 0;
    top: 0;
    z-index: 30;
  }

  .group {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 0.2rem;
  }

  button,
  .readout {
    background: rgb(8 10 14 / 78%);
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

  button:disabled {
    color: #98a0ae;
    cursor: not-allowed;
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
</style>
