<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { LiveView } from '../live.ts'
  import { transitionLabel } from '../live.ts'
  import type { OverlayId } from '../stage-view.ts'
  import { creditLine, KEY_HELP } from '../stage-view.ts'

  const { overlays, view }: { overlays: Readonly<Record<OverlayId, boolean>>; view: LiveView } = $props()

  const title = $derived(view.control.currentTitle ?? view.live.current?.title ?? view.control.current.clipId)
  const trackState = $derived(view.control.track)
  const next = $derived(view.live.next)
</script>

<div class="column">
  {#if overlays.status}
    <section aria-label="Now" class="overlay status">
      <p>
        <span class="label">Now</span> <span class="now-title">{title}</span>
        <span class="dim">{view.live.current?.engine ?? ''}</span>
      </p>
      {#if trackState && trackState.index >= 0}
        <p class="dim">
          item {trackState.index + 1} of {trackState.length} · {trackState.elapsedBars}/{trackState.bars} bars
        </p>
      {/if}
      <p>
        <span class="label">Next</span>
        <span class="next-title">{next?.title ?? next?.clipId ?? 'nothing staged'}</span>
        {#if next}
          <span class="dim">{transitionLabel(next.transition)} · {next.transitionFrom}</span>
        {/if}
      </p>
      <div class="phase" aria-hidden="true">
        <div style:width="{Math.round(view.control.barPhase * 100)}%"></div>
      </div>
    </section>
  {/if}

  {#if overlays.keys}
    <section aria-label="Keys" class="overlay keys">
      {#each KEY_HELP as [key, meaning] (key)}
        <p><kbd>{key}</kbd> {meaning}</p>
      {/each}
    </section>
  {/if}

  {#if overlays.code}
    <section aria-label="Clip code" class="overlay code">
      <pre>{view.control.code ?? 'This clip has no code loaded.'}</pre>
    </section>
  {/if}
</div>

{#if overlays.credit}
  <p class="overlay credit">{creditLine(title, view.live.current)}</p>
{/if}

<style>
  .column {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    left: 0.4rem;
    max-height: 60vh;
    max-width: min(34rem, 60vw);
    pointer-events: none;
    position: fixed;
    top: var(--row-height, 2rem);
    z-index: 10;
  }

  /* Semi-transparent, so the picture reads through it; the shadow keeps text legible on a white clip. */
  .overlay {
    background: rgb(4 6 10 / 52%);
    border-radius: 0.3rem;
    color: #fff;
    font-size: 0.72rem;
    margin: 0;
    padding: 0.3rem 0.5rem;
    pointer-events: none;
    text-shadow:
      0 0 3px #000,
      0 1px 2px #000;
  }

  .overlay p {
    margin: 0.1rem 0;
  }

  .label {
    font-size: 0.6rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .dim {
    color: #dfe4ec;
    font-size: 0.64rem;
  }

  .now-title,
  .next-title {
    font-weight: 700;
  }

  .phase {
    background: rgb(255 255 255 / 25%);
    border-radius: 999px;
    height: 0.2rem;
    margin-top: 0.2rem;
    overflow: hidden;
  }

  .phase div {
    background: #6ef2c0;
    height: 100%;
  }

  kbd {
    font-family: ui-monospace, monospace;
    font-weight: 700;
    margin-right: 0.3rem;
  }

  .code {
    flex: 0 1 auto;
    overflow: hidden;
  }

  pre {
    font-family: ui-monospace, monospace;
    font-size: 0.68rem;
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .credit {
    bottom: 1.7rem;
    font-size: 0.72rem;
    position: fixed;
    right: 0.4rem;
    z-index: 10;
  }
</style>
