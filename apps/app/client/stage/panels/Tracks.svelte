<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { Track } from '@vev/shared'

  import { createTrack, fetchTracks } from '../../track-editor.ts'

  const { onEdit }: { onEdit: (id: string) => void } = $props()

  let tracks = $state<readonly Track[]>([])
  let loading = $state(true)
  let errorMessage = $state<string | undefined>()

  let title = $state('')
  let mode = $state<Track['mode']>('noncommercial')
  let visibility = $state<Track['visibility']>('private')
  let transitionKind = $state<'crossfade' | 'cut'>('crossfade')
  let creating = $state(false)
  let createError = $state<string | undefined>()

  const load = async (): Promise<void> => {
    loading = true
    errorMessage = undefined
    try {
      tracks = await fetchTracks()
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'unknown error'
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void load()
  })

  const create = async (): Promise<void> => {
    creating = true
    createError = undefined
    try {
      const track = await createTrack({
        defaultTransition:
          transitionKind === 'cut' ? { bars: 0, kind: 'cut' } : { bars: 2, kind: 'crossfade' },
        items: [],
        mode,
        title,
        visibility,
      })
      onEdit(track.id)
    } catch (error) {
      createError = error instanceof Error ? error.message : 'unknown error'
    } finally {
      creating = false
    }
  }
</script>

{#if loading}
  <p role="status">Loading…</p>
{:else if errorMessage}
  <p role="alert">Could not load tracks: {errorMessage}</p>
{:else if tracks.length === 0}
  <p>No tracks saved yet.</p>
{:else}
  <ul class="list">
    {#each tracks as track (track.id)}
      <li>
        <button onclick={() => onEdit(track.id)} type="button">{track.title}</button>
        <span class="dim">
          {track.items.length}
          {track.items.length === 1 ? 'clip' : 'clips'} · {track.mode} · {track.visibility}
        </span>
      </li>
    {/each}
  </ul>
{/if}

<section>
  <h3>New track</h3>
  <label>
    Title
    <input bind:value={title} type="text" />
  </label>
  <label>
    Mode
    <select bind:value={mode}>
      <option value="noncommercial">noncommercial</option>
      <option value="commercial">commercial</option>
    </select>
  </label>
  <label>
    Visibility
    <select bind:value={visibility}>
      <option value="private">private</option>
      <option value="unlisted">unlisted</option>
      <option value="public">public</option>
    </select>
  </label>
  <label>
    Default transition
    <select bind:value={transitionKind}>
      <option value="crossfade">crossfade (2 bars)</option>
      <option value="cut">cut</option>
    </select>
  </label>
  <button disabled={creating || title.trim() === ''} onclick={() => void create()} type="button">
    Create
  </button>
  {#if createError}
    <p role="alert">{createError}</p>
  {/if}
</section>

<style>
  .list {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    list-style: none;
    margin: 0 0 0.8rem;
    padding: 0;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  h3 {
    font-size: 0.76rem;
    margin: 0;
  }

  label {
    display: flex;
    flex-direction: column;
    font-size: 0.68rem;
    gap: 0.1rem;
  }
</style>
