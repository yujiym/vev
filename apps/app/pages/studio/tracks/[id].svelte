<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { page } from '$app/state'
  import { fetchLibrary } from '$lib/library.ts'
  import {
    appendItem,
    fetchTrack,
    moveItem,
    removeItem,
    replaceItem,
    setSection,
    updateTrack,
  } from '$lib/track-editor.ts'
  import type { ClipSummary, Track, TrackItem } from '@vev/shared'

  /**
   * The track editor: an ordered list with up/down buttons and a section label per item. Every
   * list transform is `$lib/track-editor.ts`'s and tested there — including the one that decides
   * what "up" does to the first item (a no-op, never a wrap). ADR 0001: this file stays markup.
   */

  let track = $state<Track | undefined>()
  let items = $state<readonly TrackItem[]>([])
  let mode = $state<Track['mode']>('noncommercial')
  let clips = $state<readonly ClipSummary[]>([])
  let pick = $state('')

  let loading = $state(true)
  let loadError = $state<string | undefined>()
  let saving = $state(false)
  let saveError = $state<string | undefined>()
  let saved = $state(false)

  const titleFor = (clipId: string): string => clips.find((clip) => clip.id === clipId)?.title ?? clipId

  const load = async (id: string): Promise<void> => {
    loading = true
    loadError = undefined
    try {
      const [loaded, library] = await Promise.all([fetchTrack(id), fetchLibrary()])
      track = loaded
      ;({ items, mode } = loaded)
      clips = library
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'unknown error'
    } finally {
      loading = false
    }
  }

  $effect(() => {
    const { id } = page.params
    if (id !== undefined) {
      void load(id)
    }
  })

  const edit = (next: readonly TrackItem[]): void => {
    items = next
    saved = false
  }

  const setBars = (index: number, value: string): void => {
    const item = items[index]
    if (item === undefined) {
      return
    }

    const bars = Math.trunc(Number(value))
    // An empty or unparseable field means "no override" — the clip's own `defaultBars` then
    // applies at play time (spec §5). It is not a reason to refuse the edit.
    edit(replaceItem(items, index, { ...item, bars: Number.isFinite(bars) && bars > 0 ? bars : undefined }))
  }

  const save = async (): Promise<void> => {
    if (track === undefined) {
      return
    }

    saving = true
    saveError = undefined
    saved = false
    try {
      // `mode` travels with the items in one PATCH: the server checks the §14.2 commercial rule
      // against the MERGED track, so sending them separately could be refused for a combination
      // the editor never showed.
      const updated = await updateTrack(track.id, { items, mode })
      track = updated
      ;({ items, mode } = updated)
      saved = true
    } catch (error) {
      // This is where the server's §14.2 refusal lands, naming the clip that is not cleared.
      saveError = error instanceof Error ? error.message : 'unknown error'
    } finally {
      saving = false
    }
  }
</script>

<main>
  <p>
    <a href="/studio/tracks">Tracks</a> · <a href="/studio/clips">Library</a> ·
    <a href="/studio">Control panel</a>
  </p>

  {#if loading}
    <p role="status">Loading…</p>
  {:else if loadError}
    <p role="alert">Could not load this track: {loadError}</p>
  {:else if track}
    <h1>{track.title}</h1>

    <label>
      Mode
      <select
        onchange={(event) => {
          mode = event.currentTarget.value === 'commercial' ? 'commercial' : 'noncommercial'
          saved = false
        }}
        value={mode}
      >
        <option value="noncommercial">noncommercial</option>
        <option value="commercial">commercial — refuses clips that are not cleared (§14.2)</option>
      </select>
    </label>

    {#if items.length === 0}
      <p>This track has no clips yet.</p>
    {:else}
      <ol>
        {#each items as item, index (`${item.clipId}-${index}`)}
          <li>
            <strong>{titleFor(item.clipId)}</strong>
            <button
              aria-label="Move up"
              disabled={index === 0}
              onclick={() => edit(moveItem(items, index, 'up'))}
              type="button">↑</button
            >
            <button
              aria-label="Move down"
              disabled={index === items.length - 1}
              onclick={() => edit(moveItem(items, index, 'down'))}
              type="button">↓</button
            >
            <label>
              Section
              <input
                oninput={(event) => edit(setSection(items, index, event.currentTarget.value))}
                placeholder="intro, build, peak…"
                type="text"
                value={item.section ?? ''}
              />
            </label>
            <label>
              Bars
              <input
                min="1"
                oninput={(event) => setBars(index, event.currentTarget.value)}
                placeholder="clip default"
                type="number"
                value={item.bars ?? ''}
              />
            </label>
            <button onclick={() => edit(removeItem(items, index))} type="button">Remove</button>
          </li>
        {/each}
      </ol>
    {/if}

    <section>
      <h2>Add a clip</h2>
      <select bind:value={pick}>
        <option value="">choose a clip…</option>
        {#each clips as clip (clip.id)}
          <option value={clip.id}>
            {clip.title}{clip.commercialOk ? '' : ' — not cleared for commercial use'}
          </option>
        {/each}
      </select>
      <button
        disabled={pick === ''}
        onclick={() => {
          edit(appendItem(items, pick))
          pick = ''
        }}
        type="button">Add</button
      >
    </section>

    <button disabled={saving} onclick={() => void save()} type="button">Save</button>
    {#if saveError}
      <p role="alert">{saveError}</p>
    {:else if saved}
      <p role="status">Saved.</p>
    {/if}
  {/if}
</main>
