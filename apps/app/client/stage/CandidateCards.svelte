<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { Live, LiveView } from '../live.ts'
  import { cardBadge } from '../stage-view.ts'
  import Thumb from './Thumb.svelte'

  const { live, view }: { live: Live | undefined; view: LiveView } = $props()

  let looking = $state<string | undefined>()
</script>

<section aria-label="Candidates" class="cards">
  {#each view.live.candidates as candidate, index (candidate.clipId)}
    {@const badge = cardBadge(view, candidate.clipId)}
    <button
      class="card"
      class:chosen={badge.mark === 'chosen'}
      class:default={badge.mark === 'default'}
      class:landing={badge.mark === 'landing'}
      onblur={() => (looking = undefined)}
      onclick={() => live?.pickCandidate(candidate.clipId)}
      onfocus={() => (looking = candidate.clipId)}
      onpointerenter={() => (looking = candidate.clipId)}
      onpointerleave={() => (looking = undefined)}
      title={candidate.reason ?? ''}
      type="button"
    >
      <span class="thumb">
        <Thumb active={looking === candidate.clipId} src={candidate.thumbnailUrl} />
        <span class="key">{index + 1}</span>
        {#if badge.eta}
          <span class="eta">{badge.eta}</span>
        {/if}
      </span>
      <span class="candidate-title">{candidate.title}</span>
      <span class="meta">
        {candidate.engine ?? 'engine unknown'}
        {#if candidate.reviewed === false}
          · <span class="flag">unreviewed</span>
        {/if}
      </span>
      <span class="provenance">
        {candidate.source}{candidate.providerId === undefined ? '' : ` · ${candidate.providerId}`}
      </span>
    </button>
  {:else}
    <p class="empty">{view.live.load === 'loading' ? 'Asking for candidates…' : 'No candidates yet.'}</p>
  {/each}
  {#if view.live.load === 'stale'}
    <p class="empty stale">stale</p>
  {/if}
</section>

<style>
  .cards {
    align-items: flex-end;
    bottom: 0.4rem;
    display: flex;
    gap: 0.4rem;
    left: 0.4rem;
    max-width: calc(100vw - 0.8rem);
    position: fixed;
    z-index: 15;
  }

  .card {
    background: rgb(8 10 14 / 82%);
    border: 1px solid rgb(255 255 255 / 30%);
    border-radius: 0.35rem;
    color: #f4f6fa;
    cursor: pointer;
    display: flex;
    flex-direction: column;
    font: inherit;
    gap: 0.1rem;
    padding: 0.2rem;
    text-align: left;
    width: 9.5rem;
  }

  .card:hover {
    background: rgb(26 30 40 / 92%);
  }

  /* The outline is the one thing that says this clip is about to go live. */
  .card.chosen {
    border-color: transparent;
    outline: 3px solid #6ef2c0;
    outline-offset: 0;
  }

  .card.landing {
    outline: 1px solid #6ef2c0;
  }

  .card.default {
    border-style: dashed;
    border-color: rgb(110 242 192 / 80%);
  }

  .thumb {
    border-radius: 0.2rem;
    display: block;
    overflow: hidden;
    position: relative;
  }

  .key,
  .eta {
    background: rgb(8 10 14 / 86%);
    border-radius: 0.2rem;
    font-family: ui-monospace, monospace;
    font-size: 0.62rem;
    font-weight: 700;
    padding: 0 0.25rem;
    position: absolute;
    top: 0.15rem;
  }

  .key {
    left: 0.15rem;
  }

  .eta {
    color: #6ef2c0;
    right: 0.15rem;
  }

  .candidate-title {
    font-size: 0.72rem;
    font-weight: 700;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .meta,
  .provenance {
    color: #c3cad6;
    font-size: 0.6rem;
  }

  .provenance {
    display: none;
    font-family: ui-monospace, monospace;
  }

  .card:hover .provenance,
  .card:focus-visible .provenance {
    display: block;
  }

  .flag {
    color: #ffb454;
    font-weight: 700;
  }

  .empty {
    background: rgb(8 10 14 / 78%);
    border-radius: 0.3rem;
    color: #f4f6fa;
    font-size: 0.68rem;
    margin: 0;
    padding: 0.2rem 0.4rem;
  }

  .stale {
    color: #ffb454;
    font-weight: 700;
  }
</style>
