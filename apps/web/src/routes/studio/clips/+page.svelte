<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { LibraryFilters, LicenceFilter } from '$lib/library.ts'
  import { clipFlags, collectTags, fetchLibrary, thumbnailUrl } from '$lib/library.ts'
  import type { ClipEnergy, ClipSummary, EngineKind } from '@vev/shared'

  /**
   * The library grid. Every decision it renders — which filters reach the server, which are
   * applied here, what a clip's state looks like — lives in `$lib/library.ts`, where the type and
   * lint gate can see it (ADR 0001). This file is props in, markup out.
   */

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
    // No `reviewed` here on purpose. Nothing writes that column in M2 — annotation does not, no
    // route sets it, and neither registration schema carries it — so `?reviewed=true` could only
    // ever return zero rows. A control that cannot succeed teaches a person that reviewed clips
    // are absent, rather than that review does not exist yet. The column, its index, the route's
    // `?reviewed=` parameter and `libraryQuery`'s support for it all stay: M3's review queue is
    // what will give them a writer, and it is the control alone that is premature.
    tag: tag === '' ? undefined : tag,
  })

  const load = async (applied: LibraryFilters): Promise<void> => {
    loading = true
    errorMessage = undefined
    try {
      clips = await fetchLibrary(applied)
      // Built from what came back, so the tag list reflects the library rather than a hard-coded
      // vocabulary; annotation's own vocabulary lives on the server (`src/ingest/tags.ts`).
      allTags = collectTags(clips)
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'unknown error'
      clips = []
    } finally {
      loading = false
    }
  }

  $effect(() => {
    // The filter values are read HERE, synchronously, so this effect's dependencies do not depend
    // on where the first `await` inside `load` happens to fall.
    const applied = filters()
    void load(applied)
  })
</script>

<main>
  <h1>Library</h1>
  <p>
    <a href="/studio/clips/new">Register a clip</a> · <a href="/studio/tracks">Tracks</a> ·
    <a href="/studio">Control panel</a>
  </p>

  <section aria-label="Filters">
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
      Tag
      <input list="library-tags" bind:value={tag} placeholder="any" type="text" />
    </label>
    <datalist id="library-tags">
      {#each allTags as name (name)}
        <option value={name}></option>
      {/each}
    </datalist>

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
        {@const thumbnail = thumbnailUrl(clip)}
        <li>
          {#if thumbnail}
            <video autoplay loop muted playsinline src={thumbnail}></video>
          {:else}
            <div class="no-thumbnail">no thumbnail</div>
          {/if}
          <h2>{clip.title}</h2>
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
</main>

<style>
  .grid {
    display: grid;
    gap: 1rem;
    grid-template-columns: repeat(auto-fill, minmax(14rem, 1fr));
    list-style: none;
    padding: 0;
  }

  .grid video,
  .no-thumbnail {
    aspect-ratio: 16 / 9;
    background: #111;
    display: block;
    width: 100%;
  }

  .no-thumbnail {
    align-items: center;
    color: #888;
    display: flex;
    font-size: 0.8rem;
    justify-content: center;
  }

  .meta {
    color: #666;
    font-size: 0.8rem;
    margin: 0.2rem 0;
  }

  .flags {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
    list-style: none;
    padding: 0;
  }

  /*
   * The three tones are deliberately different shapes, not only different colours: a clip whose
   * annotation FAILED needs a human to act, while one still PENDING needs nothing but time, and
   * the grid must not make them look alike. Colour alone would also fail anyone who cannot
   * distinguish these hues.
   */
  .flag {
    border-radius: 0.2rem;
    font-size: 0.7rem;
    padding: 0.1rem 0.4rem;
  }

  .flag.attention {
    background: #7a1420;
    border: 1px solid #ff6b7a;
    color: #ffd7dc;
  }

  .flag.waiting {
    background: transparent;
    border: 1px dashed #8a8a8a;
    color: #8a8a8a;
  }

  .flag.info {
    background: #23304a;
    border: 1px solid #4a6ea0;
    color: #bcd0f0;
  }
</style>
