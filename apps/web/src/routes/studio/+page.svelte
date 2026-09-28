<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { Control, ControlSnapshot } from '$lib/control.ts'
  import { startControl } from '$lib/control.ts'
  import { fetchClip } from '$lib/library.ts'
  import { fetchTrack, fetchTrackClips, fetchTracks, resolveTrack } from '$lib/track-editor.ts'
  import { FIXTURES } from '@vev/engines'
  import type { Track } from '@vev/shared'

  /**
   * The control panel. M1's two fixture buttons are now a track selector: pick a saved track and
   * Go walks its items in order, auto-advancing on each item's `bars` (spec §7). The fixtures stay
   * as a fallback for an empty library — picking one leaves the track, which is why the button
   * says so.
   *
   * Every refusal the reducer makes while a fade is running is shown, not merely obeyed: a
   * disabled control with no explanation is indistinguishable from a broken one.
   */

  let snapshot = $state<ControlSnapshot | undefined>()
  let control: Control | undefined

  let tracks = $state<readonly Track[]>([])
  let selectedTrackId = $state('')
  let trackError = $state<string | undefined>()
  let loadingTrack = $state(false)

  $effect(() => {
    const { control: started, stop } = startControl({ startClipId: FIXTURES[0].id })
    control = started
    const unsubscribe = started.subscribe((next) => {
      snapshot = next
    })

    return () => {
      unsubscribe()
      stop()
      control = undefined
    }
  })

  $effect(() => {
    void (async () => {
      try {
        tracks = await fetchTracks()
      } catch (error) {
        trackError = error instanceof Error ? error.message : 'unknown error'
      }
    })()
  })

  const playTrack = async (id: string): Promise<void> => {
    if (id === '' || !control) {
      return
    }

    loadingTrack = true
    trackError = undefined
    try {
      const track = await fetchTrack(id)
      // A track row carries clip IDS only — never code — so the panel gathers the code itself
      // before it can put anything on screen. `resolveTrack` then applies spec §5's two
      // fallbacks (`bars` from the clip, `transitionIn` from the track).
      const clips = await fetchTrackClips(track, async (clipId) => await fetchClip(clipId))
      control.loadTrack(resolveTrack(track, clips))
    } catch (error) {
      trackError = error instanceof Error ? error.message : 'unknown error'
    } finally {
      loadingTrack = false
    }
  }

  const openOutput = (): void => {
    window.open('/output', 'vev-output')
  }
</script>

<main>
  <h1>vev — studio (control panel)</h1>
  <p><a href="/studio/clips">Library</a> · <a href="/studio/tracks">Tracks</a></p>

  <section>
    <h2>Track</h2>
    {#if snapshot?.fading}
      <p role="status">Fade in progress — a track can't be loaded until it completes.</p>
    {/if}
    <select bind:value={selectedTrackId} disabled={snapshot?.fading || loadingTrack}>
      <option value="">choose a track…</option>
      {#each tracks as track (track.id)}
        <option value={track.id}>{track.title}</option>
      {/each}
    </select>
    <button
      disabled={snapshot?.fading || loadingTrack || selectedTrackId === ''}
      onclick={() => void playTrack(selectedTrackId)}
      type="button">Load track</button
    >
    {#if trackError}
      <p role="alert">{trackError}</p>
    {/if}

    {#if snapshot?.track}
      {#if snapshot.track.index < 0 && (snapshot.armed || snapshot.fading)}
        <p role="status">
          {snapshot.track.title} — item 1 of {snapshot.track.length} is on its way in. Auto-advance takes over from
          the item after it.
        </p>
      {:else if snapshot.track.index < 0}
        <p role="status">
          {snapshot.track.title} — item 1 of {snapshot.track.length} is staged and loaded. Press Go to start the
          track; auto-advance takes over from the item after it.
        </p>
      {:else}
        <p>
          {snapshot.track.title} — item {snapshot.track.index + 1} of {snapshot.track.length}
          {snapshot.track.queued > snapshot.track.index ? '· next staged' : '· end of track'}
        </p>
      {/if}
      <label>
        <input
          checked={snapshot.track.autoAdvance}
          onchange={(event) => control?.setAutoAdvance(event.currentTarget.checked)}
          type="checkbox"
        />
        Auto-advance on each item's bars (§7)
      </label>
      <button onclick={() => control?.clearTrack()} type="button">Leave track</button>
    {:else}
      <p>No track loaded. Queue a fixture below, or pick a track above.</p>
    {/if}
  </section>

  <section>
    <h2>Fixtures</h2>
    {#if snapshot?.fading}
      <p role="status">Fade in progress — queueing is unavailable until it completes.</p>
    {/if}
    <p class="note">Queueing a fixture by hand leaves the loaded track.</p>
    {#each FIXTURES as fixture (fixture.id)}
      <button disabled={snapshot?.fading} onclick={() => control?.queue(fixture.id)} type="button">
        {fixture.title}
      </button>
    {/each}
    <p>
      Now: {snapshot?.currentTitle ?? snapshot?.current.clipId ?? '—'} · Next: {snapshot?.next
        ? (snapshot.nextTitle ?? snapshot.next.clipId)
        : '—'}{snapshot?.armed ? ' (armed — waiting for the bar)' : ''}
    </p>
  </section>

  <section>
    <h2>Transition</h2>
    {#if snapshot?.fading}
      <p role="status">Fade in progress — the transition can't be changed until it completes.</p>
    {/if}
    {#if snapshot?.track}
      <p class="note">A loaded track sets the transition for each item as it is staged.</p>
    {/if}
    <label>
      <input
        checked={snapshot?.transitionKind === 'cut'}
        disabled={snapshot?.fading}
        name="transition"
        onchange={() => control?.setTransitionKind('cut')}
        type="radio"
        value="cut"
      />
      Cut
    </label>
    <label>
      <input
        checked={snapshot?.transitionKind === 'crossfade'}
        disabled={snapshot?.fading}
        name="transition"
        onchange={() => control?.setTransitionKind('crossfade')}
        type="radio"
        value="crossfade"
      />
      Crossfade
    </label>
  </section>

  <section>
    <h2>Go</h2>
    {#if snapshot?.fading}
      <p role="status">Fade in progress — Go is unavailable until it completes; Go now finishes it early.</p>
    {/if}
    <button disabled={snapshot?.fading} onclick={() => control?.go()} type="button">Go</button>
    <button onclick={() => control?.goNow()} type="button">Go now</button>
  </section>

  <section>
    <h2>Tempo</h2>
    <button onclick={() => control?.tap()} type="button">Tap</button>
    <p>BPM: {snapshot ? Math.round(snapshot.bpm) : '—'}</p>
    <p>Bar phase: {snapshot ? snapshot.barPhase.toFixed(2) : '—'}</p>
  </section>

  <section>
    <button onclick={openOutput} type="button">Open output window</button>
  </section>
</main>

<style>
  .note {
    color: #666;
    font-size: 0.8rem;
  }
</style>
