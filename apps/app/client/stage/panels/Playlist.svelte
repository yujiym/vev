<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { Track } from '@vev/shared'

  import type { Control } from '../../control.ts'
  import { controlHints } from '../../control.ts'
  import type { Live, LiveView } from '../../live.ts'
  import { fetchTracks, playTrack } from '../../track-editor.ts'

  const {
    control,
    live,
    view,
  }: { control: Control | undefined; live: Live | undefined; view: LiveView | undefined } = $props()

  let tracks = $state<readonly Track[]>([])
  let selected = $state('')
  let loading = $state(false)
  let errorMessage = $state<string | undefined>()

  const track = $derived(view?.live.track)
  const position = $derived(view?.control.track)
  const canLoad = $derived((view?.control.canQueue ?? false) && !loading)
  const hint = $derived(view === undefined ? undefined : controlHints(view.control).track)

  $effect(() => {
    void (async () => {
      try {
        tracks = await fetchTracks()
      } catch (error) {
        errorMessage = error instanceof Error ? error.message : 'unknown error'
      }
    })()
  })

  const load = async (): Promise<void> => {
    if (control === undefined || live === undefined || selected === '') {
      return
    }

    loading = true
    errorMessage = undefined
    try {
      await playTrack(selected, { control, live })
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'unknown error'
    } finally {
      loading = false
    }
  }

  const leave = (): void => {
    control?.clearTrack()
    live?.setTrack(undefined)
  }
</script>

<div class="picker">
  <select aria-label="Track" bind:value={selected} disabled={!canLoad} id="track-select">
    <option value="">choose a track…</option>
    {#each tracks as saved (saved.id)}
      <option value={saved.id}>{saved.title}</option>
    {/each}
  </select>
  <button disabled={!canLoad || selected === ''} onclick={() => void load()} title={hint} type="button"
    >Load</button
  >
  {#if track}
    <button onclick={leave} type="button">Leave</button>
  {/if}
</div>

{#if hint}
  <p class="warning" role="status">{hint}</p>
{/if}
{#if errorMessage}
  <p role="alert">{errorMessage}</p>
{/if}

{#if track && position}
  <p class="track-status" role="status">
    {track.title}, item {Math.max(1, position.index + 1)} of {position.length}
    {#if position.index < 0 && (view?.control.armed || view?.control.fading)}
      is on its way in.
    {:else if position.index < 0}
      is staged. Press Go to start the track; auto-advance takes over after it.
    {:else if position.queued > position.index}
      · next staged
    {:else}
      · end of track
    {/if}
  </p>
  <ol class="timeline">
    {#each track.steps as step, index (index)}
      <li
        class:current={position.index === index}
        class:queued={position.queued === index && position.queued !== position.index}
      >
        <span class="section">{step.section ?? '—'}</span>
        <span class="step-title">{step.title ?? step.clipId}</span>
        <span class="dim">
          {position.index === index ? `${position.elapsedBars}/${step.bars}` : step.bars} bars
        </span>
      </li>
    {/each}
  </ol>
{:else}
  <p class="dim">No track loaded: free run. Load one for sections and automatic transitions.</p>
{/if}

<style>
  .picker {
    display: flex;
    gap: 0.4rem;
  }

  select {
    flex: 1;
  }

  .timeline {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    list-style: none;
    margin: 0.5rem 0 0;
    padding: 0;
  }

  li {
    align-items: baseline;
    background: #171b23;
    border: 1px solid #2b3240;
    border-radius: 0.3rem;
    display: grid;
    gap: 0.4rem;
    grid-template-columns: 4.5rem 1fr auto;
    padding: 0.25rem 0.4rem;
  }

  li.current {
    background: #223b34;
    border-color: #6ef2c0;
  }

  li.queued {
    border-color: #ffb454;
    border-style: dashed;
  }

  .section {
    color: #aab2c0;
    font-size: 0.62rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .step-title {
    font-weight: 600;
  }
</style>
