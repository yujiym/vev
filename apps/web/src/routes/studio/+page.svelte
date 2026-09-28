<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { Control, ControlSnapshot } from '$lib/control.ts'
  import { startControl } from '$lib/control.ts'
  import { FIXTURES } from '@vev/engines'

  let snapshot = $state<ControlSnapshot | undefined>()
  let control: Control | undefined

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

  const openOutput = (): void => {
    window.open('/output', 'vev-output')
  }
</script>

<main>
  <h1>vev — studio (debug panel)</h1>

  <section>
    <h2>Queue</h2>
    {#if snapshot?.fading}
      <p role="status">Fade in progress — queueing is unavailable until it completes.</p>
    {/if}
    {#each FIXTURES as fixture (fixture.id)}
      <button disabled={snapshot?.fading} onclick={() => control?.queue(fixture.id)} type="button">
        {fixture.title}
      </button>
    {/each}
    <p>Next: {snapshot?.next ? snapshot.next.clipId : '—'}</p>
  </section>

  <section>
    <h2>Transition</h2>
    {#if snapshot?.fading}
      <p role="status">Fade in progress — the transition can't be changed until it completes.</p>
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
