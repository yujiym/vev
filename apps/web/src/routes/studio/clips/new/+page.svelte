<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { ClipFormInput } from '$lib/register-clip.ts'
  import {
    applyPrefill,
    buildNewClip,
    captureThumbnail,
    prefillFromCode,
    runProbe,
    submitClip,
    submitThumbnail,
  } from '$lib/register-clip.ts'
  import type { ProbeResult } from '@vev/engines/hydra'
  import type { EngineKind, NewClipOrigin } from '@vev/shared'

  /**
   * This page mounts its own `HydraCompositor` (see `register-clip.ts`'s `runProbe` and
   * `captureThumbnail`) — spec §3 says rendering happens only in the output window, but §11.1
   * requires the validation probe and thumbnail recording to run in a browser, and this
   * registration screen is that browser. The context is created, used, and disposed immediately
   * on every run — never left mounted — which is what keeps this within spec §6.5's cap on live
   * WebGL contexts. Task 7 amends §3's text to say this explicitly.
   */

  const THUMBNAIL_MS = 3000

  let code = $state('')
  let title = $state('')
  let author = $state('')
  let license = $state('')
  let sourceUrl = $state('')
  let slug = $state('')
  let commercialOk = $state(false)
  let modified = $state(false)
  let origin = $state<NewClipOrigin>('imported')
  const engine: EngineKind = 'hydra'

  let probeCanvas: HTMLCanvasElement | undefined = $state()
  let recordCanvas: HTMLCanvasElement | undefined = $state()
  /** See `recordAttempt` below — the probe canvas needs the identical remount-on-retry treatment. */
  let probeAttempt = $state(0)
  let probeResult: ProbeResult | undefined = $state()
  let probing = $state(false)
  let thumbnailBlob: Blob | undefined = $state()
  let thumbnailUrl: string | undefined = $state()
  let palette: string[] = $state([])
  let recording = $state(false)
  /**
   * Bumped on every successful probe so the `{#key}` block below remounts a fresh `<canvas>`
   * element for recording each time. A re-mounted `HydraCompositor` on the SAME canvas after its
   * previous `dispose()` throws inside regl's `_initRegl` — `dispose()`'s `loseContext()` call
   * (spec §6.5) really does lose the context, permanently, for that element. Confirmed manually
   * (see the M2 task 4 report); a fresh canvas per attempt sidesteps it entirely.
   */
  let recordAttempt = $state(0)
  let saving = $state(false)
  let saveError: string | undefined = $state()
  let savedClipId: string | undefined = $state()

  const runValidation = async (): Promise<void> => {
    if (!probeCanvas || code.trim() === '') {
      return
    }

    const prefill = prefillFromCode(code)
    // The "only fill in what's still empty" decision lives in `applyPrefill` (register-clip.ts),
    // tested there — this is just wiring its result back onto the three form fields.
    ;({ author, license, sourceUrl } = applyPrefill({ author, license, sourceUrl }, prefill))

    probing = true
    probeResult = undefined
    thumbnailBlob = undefined
    thumbnailUrl = undefined
    palette = []
    try {
      probeResult = await runProbe(code, probeCanvas)
    } finally {
      probing = false
      probeAttempt += 1
    }
  }

  const recordThumbnailForClip = async (): Promise<void> => {
    if (!recordCanvas || !probeResult?.ok) {
      return
    }

    recording = true
    try {
      // A SEPARATE canvas from the probe's — `runProbe` disposes its `HydraCompositor` via
      // `loseContext()` (spec §6.5), and re-mounting a fresh Hydra instance on that same,
      // now-lost-context canvas throws inside regl's `_initRegl` (confirmed manually: see the M2
      // task 4 report). Two canvases used one at a time never violates §6.5's cap — at most one
      // live WebGL context exists at once, since the probe's is already disposed by the time this
      // one is created.
      const capture = await captureThumbnail(code, recordCanvas, THUMBNAIL_MS)
      ;({ blob: thumbnailBlob, palette } = capture)
      thumbnailUrl = URL.createObjectURL(thumbnailBlob)
    } finally {
      recording = false
      // Remount a fresh `<canvas>` (see `recordAttempt`'s doc comment) so a retry — the button is
      // never disabled after one attempt — doesn't reuse a canvas whose context this attempt just
      // disposed.
      recordAttempt += 1
    }
  }

  const save = async (): Promise<void> => {
    saveError = undefined
    saving = true
    try {
      const form: ClipFormInput = {
        author,
        code,
        commercialOk,
        engine,
        license,
        modified,
        origin,
        slug: slug === '' ? undefined : slug,
        sourceUrl: sourceUrl === '' ? undefined : sourceUrl,
        title,
      }
      const clip = await submitClip(buildNewClip(form))
      savedClipId = clip.id

      if (thumbnailBlob) {
        await submitThumbnail(clip.id, thumbnailBlob)
      }
    } catch (error) {
      saveError = error instanceof Error ? error.message : String(error)
    } finally {
      saving = false
    }
  }
</script>

<main>
  <h1>Register a clip</h1>

  {#key probeAttempt}
    <canvas bind:this={probeCanvas} height="180" width="320"></canvas>
  {/key}

  <section>
    <h2>1. Paste code</h2>
    <label>
      Clip code
      <textarea bind:value={code} rows="8"></textarea>
    </label>
    <button disabled={probing || code.trim() === ''} onclick={runValidation} type="button">
      {probing ? 'Running probe…' : 'Run probe'}
    </button>

    {#if probeResult}
      {#if probeResult.ok}
        <p role="status">Probe passed — max frame time {probeResult.maxFrameMs.toFixed(1)}ms.</p>
      {:else}
        <p role="alert">Probe failed: {probeResult.message ?? probeResult.reason}</p>
      {/if}
    {/if}
  </section>

  {#if probeResult?.ok}
    <section>
      <h2>2. Record thumbnail</h2>
      {#key recordAttempt}
        <canvas bind:this={recordCanvas} height="180" width="320"></canvas>
      {/key}
      <button disabled={recording} onclick={recordThumbnailForClip} type="button">
        {recording ? 'Recording…' : 'Record thumbnail'}
      </button>
      {#if thumbnailUrl}
        <video controls src={thumbnailUrl}>
          <track kind="captions" />
        </video>
        <p>Palette: {palette.join(', ')}</p>
      {/if}
    </section>

    <section>
      <h2>3. Details</h2>
      <label>
        Title
        <input bind:value={title} type="text" />
      </label>
      <label>
        Author
        <input bind:value={author} type="text" />
      </label>
      <label>
        Licence
        <input bind:value={license} type="text" />
      </label>
      <label>
        Source URL
        <input bind:value={sourceUrl} type="text" />
      </label>
      <label>
        Slug (optional)
        <input bind:value={slug} type="text" />
      </label>
      <label>
        <input bind:checked={modified} type="checkbox" />
        Modified from source
      </label>
      <label>
        <input bind:checked={commercialOk} type="checkbox" />
        Commercial use OK
      </label>
      <label>
        Origin
        <select bind:value={origin}>
          <option value="imported">Imported</option>
          <option value="authored">Authored</option>
        </select>
      </label>

      <button disabled={saving} onclick={save} type="button">{saving ? 'Saving…' : 'Save clip'}</button>
      {#if saveError}
        <p role="alert">{saveError}</p>
      {/if}
      {#if savedClipId}
        <p role="status">Saved as {savedClipId}.</p>
      {/if}
    </section>
  {/if}
</main>

<style>
  main {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
    padding: 1rem;
  }

  section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-width: 32rem;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
</style>
