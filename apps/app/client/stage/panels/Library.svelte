<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { ClipEnergy, ClipSummary, EngineKind } from '@vev/shared'

  import type { LibraryFilters, LicenceFilter } from '../../library.ts'
  import { clipFlags, collectTags, fetchLibrary, thumbnailUrl } from '../../library.ts'
  import Thumb from '../Thumb.svelte'

  const { onNewClip }: { onNewClip: () => void } = $props()

  const ENGINES: EngineKind[] = ['hydra', 'textmode', 'isf']
  const ENERGIES: ClipEnergy[] = [1, 2, 3, 4, 5]

  let engine = $state<EngineKind | ''>('')
  let tag = $state('')
  let energy = $state<ClipEnergy | 0>(0)
  let licence = $state<LicenceFilter>('any')

  let clips = $state<readonly ClipSummary[]>([])
  let allTags = $state<readonly string[]>([])
  let loading = $state(false)
  let errorMessage = $state<string | undefined>()

  const filters = (): LibraryFilters => ({
    energy: energy === 0 ? undefined : energy,
    engine: engine === '' ? undefined : engine,
    licence,
    // No `reviewed` here on purpose. Nothing writes that column yet, so `?reviewed=true` could only
    // ever return zero rows, and a control that cannot succeed teaches a person that reviewed clips
    // are absent rather than that review does not exist yet.
    tag: tag === '' ? undefined : tag,
  })

  const load = async (applied: LibraryFilters): Promise<void> => {
    loading = true
    errorMessage = undefined
    try {
      clips = await fetchLibrary(applied)
      allTags = collectTags(clips)
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'unknown error'
      clips = []
    } finally {
      loading = false
    }
  }

  $effect(() => {
    // Read HERE, synchronously, so this effect's dependencies do not depend on where the first
    // `await` inside `load` happens to fall.
    const applied = filters()
    void load(applied)
  })
</script>

<p><button onclick={onNewClip} type="button">Register a clip</button></p>

<section aria-label="Filters" class="filters">
  <label>
    Engine
    <select bind:value={engine}>
      <option value="">any</option>
      {#each ENGINES as kind (kind)}
        <option value={kind}>{kind}</option>
      {/each}
    </select>
  </label>
  <label>
    Energy
    <select bind:value={energy}>
      <option value={0}>any</option>
      {#each ENERGIES as level (level)}
        <option value={level}>{level}</option>
      {/each}
    </select>
  </label>
  <label>
    Licence
    <select bind:value={licence}>
      <option value="any">any</option>
      <option value="commercial-ok">cleared for commercial use</option>
      <option value="unknown">licence unknown</option>
    </select>
  </label>
  <label>
    Tag
    <input bind:value={tag} list="library-tags" placeholder="any" type="text" />
  </label>
  <datalist id="library-tags">
    {#each allTags as name (name)}
      <option value={name}></option>
    {/each}
  </datalist>
  <button onclick={() => void load(filters())} type="button">Refresh</button>
</section>

{#if loading}
  <p role="status">Loading…</p>
{:else if errorMessage}
  <p role="alert">Could not load the library: {errorMessage}</p>
{:else if clips.length === 0}
  <p>No clips match these filters.</p>
{:else}
  <ul class="grid">
    {#each clips as clip (clip.id)}
      <li>
        <Thumb src={thumbnailUrl(clip)} />
        <h3>{clip.title}</h3>
        <p class="meta">
          {clip.engine} · {clip.license}{clip.energy === undefined ? '' : ` · energy ${clip.energy}`}
        </p>
        {#if clip.tags && clip.tags.length > 0}
          <p class="meta">{clip.tags.join(', ')}</p>
        {/if}
        <ul class="flags">
          {#each clipFlags(clip) as flag (flag.id)}
            <li class="flag {flag.tone}" title={flag.detail}>{flag.label}</li>
          {/each}
        </ul>
      </li>
    {/each}
  </ul>
{/if}

<style>
  .filters {
    align-items: flex-end;
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin-bottom: 0.5rem;
  }

  label {
    display: flex;
    flex-direction: column;
    font-size: 0.68rem;
    gap: 0.1rem;
  }

  input {
    width: 6rem;
  }

  .grid {
    display: grid;
    gap: 0.5rem;
    grid-template-columns: repeat(auto-fill, minmax(9rem, 1fr));
    list-style: none;
    margin: 0;
    padding: 0;
  }

  h3 {
    font-size: 0.76rem;
    margin: 0.2rem 0 0;
  }

  .meta {
    color: #aab2c0;
    font-size: 0.66rem;
    margin: 0.1rem 0;
  }

  .flags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.2rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  /*
   * The three tones are deliberately different shapes, not only different colours: a clip whose
   * annotation FAILED needs a human to act, while one still PENDING needs nothing but time.
   */
  .flag {
    border-radius: 0.2rem;
    font-size: 0.6rem;
    padding: 0.05rem 0.3rem;
  }

  .flag.attention {
    background: #7a1420;
    border: 1px solid #ff6b7a;
    color: #ffd7dc;
  }

  .flag.waiting {
    background: transparent;
    border: 1px dashed #8a8a8a;
    color: #b0b0b0;
  }

  .flag.info {
    background: #23304a;
    border: 1px solid #4a6ea0;
    color: #bcd0f0;
  }
</style>
