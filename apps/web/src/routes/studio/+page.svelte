<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { Control, PlayableClip } from '$lib/control.ts'
  import { controlHints, startControl } from '$lib/control.ts'
  import { fetchClip, fetchLibrary } from '$lib/library.ts'
  import type { Live, LiveView } from '$lib/live.ts'
  import { createLive, nextTransitionChoice, transitionLabel } from '$lib/live.ts'
  import { fetchTrack, fetchTrackClips, fetchTracks, resolveTrack } from '$lib/track-editor.ts'
  import { FIXTURES } from '@vev/engines'
  import type { Track } from '@vev/shared'

  /**
   * The control screen of spec §12.1. Every decision it renders — candidates, Next, the transition,
   * the direction, the key map — lives in `$lib/live.ts`, `$lib/control.ts` and `@vev/decision`.
   * This file is props in, markup out, because templates are outside the type and lint gate
   * (ADR 0001).
   */

  let view = $state.raw<LiveView | undefined>()
  let control: Control | undefined
  let live: Live | undefined

  let tracks = $state<readonly Track[]>([])
  let selectedTrackId = $state('')
  let trackError = $state<string | undefined>()
  let loadingTrack = $state(false)

  let chatOpen = $state(false)
  let chatFocused = $state(false)
  let chatText = $state('')
  let chatInput: HTMLTextAreaElement | undefined = $state()

  const hints = $derived(view === undefined ? undefined : controlHints(view.control))
  const next = $derived(view?.live.next)
  const candidates = $derived(view?.live.candidates ?? [])
  const current = $derived(view?.live.current)
  const direction = $derived(view?.live.direction)
  const decision = $derived(view?.live.decision)
  const track = $derived(view?.live.track)
  const trackState = $derived(view?.control.track)
  const panic = $derived(view?.control.panic ?? 'none')

  const nowTitle = $derived(
    view?.control.currentTitle ?? current?.title ?? view?.control.current.clipId ?? 'nothing yet',
  )
  const nowEngine = $derived(current?.engine)
  const barPercent = $derived.by(() => {
    const run = view?.control.track
    if (run === undefined || run.bars <= 0) {
      return 0
    }
    return Math.min(100, Math.round((run.elapsedBars / run.bars) * 100))
  })

  $effect(() => {
    let cancelled = false
    let teardown: (() => void) | undefined

    const openChat = (): void => {
      chatOpen = true
    }
    const closeChat = (): void => {
      chatOpen = false
      chatFocused = false
      chatInput?.blur()
    }

    void (async () => {
      // Start on a real library clip when there is one: candidates are requested straight away
      // (spec §8.3), and a fixture that is not in the library would only ever produce a 404.
      let clips: PlayableClip[] = []
      let startClipId = FIXTURES[0].id
      try {
        const [first] = await fetchLibrary()
        if (first !== undefined) {
          const clip = await fetchClip(first.id)
          startClipId = clip.id
          clips = [{ code: clip.code, id: clip.id, title: clip.title }]
        }
      } catch {
        // No library (or no API) is a normal local start: the fixtures still play.
      }
      if (cancelled) {
        return
      }

      const started = startControl(clips.length > 0 ? { clips, startClipId } : { startClipId })
      const session = createLive({ control: started.control, onChat: openChat, onCloseChat: closeChat })
      ;({ control } = started)
      live = session

      const unsubscribe = session.subscribe((nextView) => {
        view = nextView
      })
      const onKey = (event: KeyboardEvent): void => {
        if (session.key(event, { chatFocused })) {
          event.preventDefault()
        }
      }
      window.addEventListener('keydown', onKey)

      teardown = () => {
        window.removeEventListener('keydown', onKey)
        unsubscribe()
        session.stop()
        started.stop()
        control = undefined
        live = undefined
        view = undefined
      }
    })()

    return () => {
      cancelled = true
      teardown?.()
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

  $effect(() => {
    if (chatOpen && chatInput !== undefined) {
      chatInput.focus()
      chatFocused = true
    }
  })

  const playTrack = async (id: string): Promise<void> => {
    if (id === '' || control === undefined || live === undefined) {
      return
    }

    loadingTrack = true
    trackError = undefined
    try {
      const saved = await fetchTrack(id)
      const clips = await fetchTrackClips(saved, async (clipId) => await fetchClip(clipId))
      const resolved = resolveTrack(saved, clips)
      control.loadTrack(resolved)
      live.setTrack({
        defaultTransition: resolved.defaultTransition,
        id: resolved.id,
        mode: resolved.mode,
        steps: resolved.steps,
        title: resolved.title,
      })
    } catch (error) {
      trackError = error instanceof Error ? error.message : 'unknown error'
    } finally {
      loadingTrack = false
    }
  }

  const leaveTrack = (): void => {
    control?.clearTrack()
    live?.setTrack(undefined)
  }

  const submitChat = (event: SubmitEvent): void => {
    event.preventDefault()
    live?.interpret(chatText)
    chatText = ''
  }

  const openOutput = (): void => {
    window.open('/output', 'vev-output')
  }
</script>

<main class="live">
  <h1 class="sr-only">vev control</h1>

  <header class="topbar">
    <div class="track-picker">
      <label for="track-select">Track</label>
      <select
        bind:value={selectedTrackId}
        disabled={!view?.control.canQueue || loadingTrack}
        id="track-select"
      >
        <option value="">choose a track…</option>
        {#each tracks as saved (saved.id)}
          <option value={saved.id}>{saved.title}</option>
        {/each}
      </select>
      <button
        disabled={!view?.control.canQueue || loadingTrack || selectedTrackId === ''}
        onclick={() => void playTrack(selectedTrackId)}
        type="button">Load</button
      >
      {#if track}
        <button onclick={leaveTrack} type="button">Leave</button>
      {/if}
    </div>

    <div class="tempo">
      <span class="bpm">{view ? Math.round(view.control.bpm) : '—'}</span>
      <span class="unit">BPM</span>
      <button onclick={() => control?.tap()} type="button">TAP</button>
    </div>

    <label class="auto">
      <input
        checked={trackState?.autoAdvance ?? false}
        disabled={trackState === undefined}
        onchange={(event) => control?.setAutoAdvance(event.currentTarget.checked)}
        type="checkbox"
      />
      Auto
    </label>

    <div
      class="decision"
      class:decision-ok={decision?.tone === 'decision'}
      class:decision-warn={decision?.tone === 'fallback'}
      class:decision-bad={decision?.tone === 'stale'}
    >
      <span class="dot" aria-hidden="true"></span>
      <span>{decision?.label ?? 'starting…'}</span>
    </div>

    <button class="output" onclick={openOutput} type="button">Output ↗</button>
  </header>

  {#if trackError}
    <p class="error" role="alert">{trackError}</p>
  {/if}
  {#if hints?.track}
    <p class="status" role="status">{hints.track}</p>
  {/if}
  {#if track && trackState}
    <p class="status track-status" role="status">
      {track.title} — item {Math.max(1, trackState.index + 1)} of {trackState.length}
      {#if trackState.index < 0 && (view?.control.armed || view?.control.fading)}
        is on its way in.
      {:else if trackState.index < 0}
        is staged. Press Go to start the track; auto-advance takes over after it.
      {:else if trackState.queued > trackState.index}
        · next staged
      {:else}
        · end of track
      {/if}
    </p>
  {/if}

  <section class="stage">
    <article class="panel now">
      <h2>NOW</h2>
      <p class="clip-title">{nowTitle}</p>
      <p class="clip-meta">
        {nowEngine ?? 'engine unknown'}
        {#if trackState && trackState.index >= 0}
          · item {trackState.index + 1} of {trackState.length}
        {/if}
      </p>

      {#if trackState && trackState.index >= 0 && trackState.bars > 0}
        <div class="bars">
          <div class="bar-track">
            <div class="bar-fill" style:width="{barPercent}%"></div>
          </div>
          <span>{trackState.elapsedBars}/{trackState.bars} bars</span>
        </div>
      {:else}
        <div class="bars">
          <div class="bar-track">
            <div class="bar-fill" style:width="{Math.round((view?.control.barPhase ?? 0) * 100)}%"></div>
          </div>
          <span>bar phase {(view?.control.barPhase ?? 0).toFixed(2)}</span>
        </div>
      {/if}

      {#if view?.control.held}
        <p class="held" role="status">Hold is on — auto-advance is paused until Go or Hold again.</p>
      {/if}
      {#if panic !== 'none'}
        <p class="held" role="status">Panic: {panic}</p>
      {/if}

      <div class="row">
        <button class:active={view?.control.held} onclick={() => control?.hold()} type="button">Hold</button>
        <button disabled={!view?.control.canBack} onclick={() => control?.back()} type="button">Back</button>
      </div>
      {#if hints?.back}
        <p class="hint" role="status">{hints.back}</p>
      {/if}
    </article>

    <article class="panel next">
      <h2>NEXT</h2>
      {#if next}
        <p class="clip-title">{next.title ?? next.clipId}</p>
        <p class="clip-meta">
          {#if next.source === 'track'}
            track item
          {:else if next.candidateIndex === undefined}
            already staged
          {:else}
            candidate {next.candidateIndex + 1}
          {/if}
        </p>
        <p class="transition">
          {transitionLabel(next.transition)}
          <span class="provenance">{next.transitionFrom}</span>
        </p>
      {:else}
        <p class="clip-title muted">waiting for a candidate</p>
        <p class="clip-meta">
          {#if view?.live.load === 'stale'}
            candidates are stale; the show keeps playing
          {:else}
            {view?.live.load === 'loading'
              ? 'asking the decision layer…'
              : 'load a track or wait for the first candidate'}
          {/if}
        </p>
      {/if}

      <div class="row">
        <button
          disabled={view === undefined || !view.control.canSetTransition || next === undefined}
          onclick={() => {
            if (view !== undefined) {
              live?.chooseTransition(nextTransitionChoice(next?.transition ?? view.control.transition))
            }
          }}
          type="button">Change</button
        >
        <button disabled={!view?.control.canGo} onclick={() => control?.go()} type="button">Go</button>
        <button disabled={!view?.control.canGoNow} onclick={() => control?.goNow()} type="button"
          >Go now</button
        >
      </div>
      {#if hints?.go}
        <p class="hint" role="status">{hints.go}</p>
      {/if}
      {#if hints?.transition}
        <p class="hint" role="status">{hints.transition}</p>
      {/if}
      {#if hints?.queue}
        <p class="hint" role="status">{hints.queue}</p>
      {/if}
      {#if view?.live.error}
        <p class="hint error" role="status">Candidates stale — {view.live.error}</p>
      {/if}
    </article>
  </section>

  <section class="timeline">
    <h2>Track timeline</h2>
    {#if track}
      <ol>
        {#each track.steps as step, index (index)}
          <li
            class:current={trackState?.index === index}
            class:queued={trackState?.queued === index && trackState?.queued !== trackState?.index}
          >
            <span class="section">{step.section ?? '—'}</span>
            <span class="step-title">{step.title ?? step.clipId}</span>
            <span class="step-bars">{step.bars}b</span>
          </li>
        {/each}
      </ol>
      <p class="muted">{track.title} · {track.steps.length} items</p>
    {:else}
      <p class="muted">No track loaded — free run. Load one above for sections and automatic transitions.</p>
    {/if}
  </section>

  <section class="chat">
    <div class="direction">
      <span class="label">Steering</span>
      {#if direction}
        <span class="direction-text">“{direction.text}”</span>
        <span class="provenance">{direction.source}</span>
        <button onclick={() => live?.clearDirection()} type="button">Clear</button>
      {:else}
        <span class="muted">No standing direction — the chat steers what is offered.</span>
      {/if}
      <button class="chat-toggle" onclick={() => (chatOpen = !chatOpen)} type="button">
        {chatOpen ? 'Close chat' : 'Chat'}
      </button>
    </div>

    {#if chatOpen}
      <form onsubmit={submitChat}>
        <textarea
          bind:this={chatInput}
          bind:value={chatText}
          onblur={() => (chatFocused = false)}
          onfocus={() => (chatFocused = true)}
          placeholder="darker, slower… (C opens, Esc closes)"
          rows="2"></textarea>
        <button disabled={chatText.trim() === ''} type="submit">Send</button>
      </form>
    {/if}
  </section>

  <section class="candidates">
    {#if candidates.length === 0}
      <p class="muted">
        No candidates yet. They are requested as soon as a clip starts playing and again when the direction
        changes.
      </p>
    {:else}
      {#each candidates as candidate, index (candidate.clipId)}
        <button
          class="candidate"
          class:selected={view?.live.pickedClipId === candidate.clipId}
          class:leading={next?.source === 'candidate' && next.candidateIndex === index}
          disabled={!view?.control.canQueue}
          onclick={() => live?.pickCandidate(candidate.clipId)}
          type="button"
        >
          <span class="rank">
            {#if next?.source === 'candidate' && next.candidateIndex === index}★{:else}{index + 1}{/if}
          </span>
          {#if candidate.thumbnailUrl}
            <video autoplay loop muted playsinline src={candidate.thumbnailUrl}></video>
          {:else}
            <span class="no-thumb">no thumbnail</span>
          {/if}
          <span class="candidate-title">{candidate.title}</span>
          <span class="clip-meta">{candidate.engine ?? 'engine unknown'}</span>
          {#if candidate.reason}
            <span class="reason">{candidate.reason}</span>
          {/if}
          <span class="provenance">
            {candidate.source}{candidate.providerId === undefined ? '' : ` · ${candidate.providerId}`}
          </span>
          {#if candidate.reviewed === false}
            <span class="flag">unreviewed</span>
          {/if}
        </button>
      {/each}
    {/if}
  </section>

  <footer class="panic">
    <button class:active={panic === 'blackout'} onclick={() => control?.blackout()} type="button"
      >Blackout</button
    >
    <button class:active={panic === 'freeze'} onclick={() => control?.freeze()} type="button">Freeze</button>
    <span class="keys"
      >1/2/3 candidates · Space go · Shift+Space go now · H hold · B blackout · Esc freeze · C chat</span
    >
  </footer>
</main>

<style>
  :global(body) {
    background: #08090c;
    color: #f2f4f8;
    font-family:
      ui-sans-serif,
      system-ui,
      -apple-system,
      'Segoe UI',
      sans-serif;
    margin: 0;
  }

  .live {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-height: 100vh;
    padding: 0.9rem;
  }

  .sr-only {
    height: 1px;
    margin: -1px;
    overflow: hidden;
    position: absolute;
    width: 1px;
  }

  h2 {
    color: #9aa3b2;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.14em;
    margin: 0 0 0.45rem;
    text-transform: uppercase;
  }

  button,
  select,
  textarea {
    background: #171b23;
    border: 1px solid #313846;
    border-radius: 0.45rem;
    color: #eef1f6;
    font: inherit;
  }

  button {
    cursor: pointer;
    font-weight: 600;
    padding: 0.5rem 0.8rem;
  }

  button:hover:not(:disabled) {
    background: #222836;
    border-color: #4b5566;
  }

  button:disabled {
    cursor: not-allowed;
    opacity: 0.38;
  }

  button.active {
    background: #223b34;
    border-color: #6ef2c0;
    color: #b9ffe4;
  }

  select {
    padding: 0.45rem 0.6rem;
  }

  .topbar {
    align-items: center;
    background: #0d1016;
    border: 1px solid #232936;
    border-radius: 0.6rem;
    display: flex;
    flex-wrap: wrap;
    gap: 0.8rem 1.2rem;
    padding: 0.6rem 0.8rem;
  }

  .track-picker,
  .tempo,
  .auto,
  .decision {
    align-items: center;
    display: flex;
    gap: 0.5rem;
  }

  .track-picker label,
  .tempo .unit {
    color: #9aa3b2;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .bpm {
    font-family: ui-monospace, monospace;
    font-size: 1.5rem;
    font-variant-numeric: tabular-nums;
    font-weight: 700;
  }

  .decision {
    color: #c9d0dc;
    font-size: 0.82rem;
    margin-left: auto;
  }

  .decision .dot {
    background: #6ef2c0;
    border-radius: 50%;
    height: 0.6rem;
    width: 0.6rem;
  }

  .decision-warn .dot {
    background: #ffb454;
  }

  .decision-bad .dot {
    background: #ff6470;
  }

  .output {
    border-color: #6ef2c0;
    color: #b9ffe4;
  }

  .stage {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: 1.2fr 1fr;
  }

  .panel {
    background: #101319;
    border: 1px solid #232936;
    border-radius: 0.7rem;
    padding: 0.8rem 0.9rem;
  }

  .clip-title {
    font-size: 1.35rem;
    font-weight: 700;
    margin: 0 0 0.2rem;
  }

  .clip-meta {
    color: #9aa3b2;
    font-size: 0.82rem;
    margin: 0;
  }

  .muted {
    color: #8b94a3;
  }

  .bars {
    align-items: center;
    color: #c9d0dc;
    display: flex;
    font-family: ui-monospace, monospace;
    font-size: 0.78rem;
    gap: 0.6rem;
    margin: 0.8rem 0;
  }

  .bar-track {
    background: #232936;
    border-radius: 999px;
    flex: 1;
    height: 0.55rem;
    overflow: hidden;
  }

  .bar-fill {
    background: #6ef2c0;
    height: 100%;
    transition: width 120ms linear;
  }

  .row {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.7rem;
  }

  .hint,
  .status,
  .error {
    font-size: 0.78rem;
    margin: 0.5rem 0 0;
  }

  .hint {
    color: #ffb454;
  }

  .error {
    color: #ff6470;
  }

  .held {
    color: #ffb454;
    font-size: 0.8rem;
    margin: 0.45rem 0 0;
  }

  .transition {
    align-items: baseline;
    display: flex;
    gap: 0.5rem;
    margin: 0.6rem 0 0;
  }

  .provenance {
    color: #7f899a;
    font-family: ui-monospace, monospace;
    font-size: 0.68rem;
  }

  .timeline {
    background: #0d1016;
    border: 1px solid #232936;
    border-radius: 0.6rem;
    padding: 0.6rem 0.8rem;
  }

  .timeline ol {
    display: flex;
    gap: 0.35rem;
    list-style: none;
    margin: 0;
    overflow-x: auto;
    padding: 0;
  }

  .timeline li {
    background: #171b23;
    border: 1px solid #2b3240;
    border-radius: 0.4rem;
    display: grid;
    gap: 0.15rem;
    min-width: 7rem;
    padding: 0.35rem 0.5rem;
  }

  .timeline li.current {
    background: #223b34;
    border-color: #6ef2c0;
  }

  .timeline li.queued {
    border-style: dashed;
    border-color: #ffb454;
  }

  .section {
    color: #9aa3b2;
    font-size: 0.62rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }

  .step-title {
    font-size: 0.78rem;
    font-weight: 600;
  }

  .step-bars {
    color: #7f899a;
    font-family: ui-monospace, monospace;
    font-size: 0.68rem;
  }

  .timeline p {
    font-size: 0.75rem;
    margin: 0.45rem 0 0;
  }

  .chat {
    background: #0d1016;
    border: 1px solid #232936;
    border-radius: 0.6rem;
    padding: 0.6rem 0.8rem;
  }

  .direction {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 0.6rem;
  }

  .label {
    color: #9aa3b2;
    font-size: 0.72rem;
    font-weight: 700;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  .direction-text {
    color: #b9ffe4;
    font-size: 0.95rem;
  }

  .chat-toggle {
    margin-left: auto;
  }

  .chat form {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.6rem;
  }

  .chat textarea {
    flex: 1;
    padding: 0.5rem 0.6rem;
    resize: vertical;
  }

  .candidates {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }

  .candidate {
    align-items: stretch;
    background: #101319;
    border: 1px solid #2b3240;
    border-radius: 0.7rem;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    padding: 0.6rem;
    text-align: left;
  }

  .candidate.leading {
    border-color: #6ef2c0;
    box-shadow: 0 0 0 1px #6ef2c0 inset;
  }

  .candidate.selected {
    background: #223b34;
  }

  .rank {
    color: #6ef2c0;
    font-family: ui-monospace, monospace;
    font-size: 0.8rem;
    font-weight: 700;
  }

  .candidate video,
  .no-thumb {
    background: #05060a;
    border: 1px solid #232936;
    border-radius: 0.4rem;
    display: block;
    height: 6rem;
    object-fit: cover;
    width: 100%;
  }

  .no-thumb {
    align-items: center;
    color: #6b7484;
    display: flex;
    font-size: 0.7rem;
    justify-content: center;
  }

  .candidate-title {
    font-size: 1rem;
    font-weight: 700;
  }

  .reason {
    color: #c9d0dc;
    font-size: 0.76rem;
  }

  .flag {
    color: #ffb454;
    font-size: 0.66rem;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .panic {
    align-items: center;
    background: #0d1016;
    bottom: 0;
    position: sticky;
    z-index: 5;
    border: 1px solid #232936;
    border-radius: 0.6rem;
    display: flex;
    gap: 0.6rem;
    padding: 0.55rem 0.8rem;
  }

  .panic .keys {
    color: #6b7484;
    font-size: 0.68rem;
    margin-left: auto;
  }

  @media (max-width: 800px) {
    .stage,
    .candidates {
      grid-template-columns: 1fr;
    }
  }
</style>
