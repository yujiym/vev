<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { ProbeResult } from '@vev/engines/hydra'
  import type { EngineKind, NewClipOrigin } from '@vev/shared'

  import type { ClipFormInput } from '../../register-clip.ts'
  import {
    applyPrefill,
    buildNewClip,
    captureThumbnail,
    prefillFromCode,
    runProbe,
    submitClip,
    submitStills,
    submitThumbnail,
  } from '../../register-clip.ts'
  import type { RegistrationGate } from '../../stage-view.ts'

  /**
   * This panel mounts its own transient `HydraCompositor` beside the live one (ADR 0012, §11.1). The
   * probe and the recording run one at a time, each on a fresh canvas, and are disposed on every
   * path. `gate` keeps them away from a switch in flight.
   */

  const { gate }: { gate: RegistrationGate } = $props()

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
  /** A disposed context is lost for good on its canvas, so every attempt gets a fresh `<canvas>`. */
  let probeAttempt = $state(0)
  let recordAttempt = $state(0)
  let probeResult: ProbeResult | undefined = $state()
  let probing = $state(false)
  let thumbnailBlob: Blob | undefined = $state()
  let thumbnailUrl: string | undefined = $state()
  let palette: string[] = $state([])
  let stills: Blob[] = $state([])
  let stillsWarning: string | undefined = $state()
  let recording = $state(false)
  let captureError: string | undefined = $state()
  let saving = $state(false)
  let saveError: string | undefined = $state()
  let savedClipId: string | undefined = $state()

  const refused = $derived(gate.kind === 'refused')

  const runValidation = async (): Promise<void> => {
    if (!probeCanvas || code.trim() === '' || refused) {
      return
    }

    const prefill = prefillFromCode(code)
    ;({ author, license, sourceUrl } = applyPrefill({ author, license, sourceUrl }, prefill))

    probing = true
    probeResult = undefined
    thumbnailBlob = undefined
    thumbnailUrl = undefined
    palette = []
    stills = []
    captureError = undefined
    try {
      probeResult = await runProbe(code, probeCanvas)
    } finally {
      probing = false
      probeAttempt += 1
    }
  }

  const recordThumbnailForClip = async (): Promise<void> => {
    if (!recordCanvas || !probeResult?.ok || refused) {
      return
    }

    recording = true
    captureError = undefined
    try {
      const capture = await captureThumbnail(code, recordCanvas, THUMBNAIL_MS)
      ;({ blob: thumbnailBlob, palette, stills } = capture)
      thumbnailUrl = URL.createObjectURL(thumbnailBlob)
    } catch (error) {
      captureError = error instanceof Error ? error.message : String(error)
    } finally {
      recording = false
      recordAttempt += 1
    }
  }

  const save = async (): Promise<void> => {
    saveError = undefined
    stillsWarning = undefined
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

      // Before the thumbnail, and never throwing: the stills are an enhancement to annotation, so
      // neither their failure nor the thumbnail's may stop the other.
      stillsWarning = await submitStills(clip.id, stills)

      if (thumbnailBlob) {
        await submitThumbnail(clip.id, thumbnailBlob, palette)
      }
    } catch (error) {
      saveError = error instanceof Error ? error.message : String(error)
    } finally {
      saving = false
    }
  }
</script>

<p class="warning" role="note">
  The show keeps running. A probe and a recording share its GPU and can make the picture stutter, so register
  clips before the doors open.
</p>
{#if gate.kind === 'refused'}
  <p class="warning refusal" role="status">{gate.reason}</p>
{/if}

{#key probeAttempt}
  <canvas bind:this={probeCanvas} height="180" width="320"></canvas>
{/key}

<section>
  <h3>1. Paste code</h3>
  <label>
    Clip code
    <textarea bind:value={code} rows="6"></textarea>
  </label>
  <button disabled={probing || code.trim() === '' || refused} onclick={runValidation} type="button">
    {probing ? 'Running probe…' : 'Run probe'}
  </button>

  {#if probeResult}
    {#if probeResult.ok}
      <p role="status">Probe passed — max frame time {probeResult.maxFrameMs.toFixed(1)}ms.</p>
    {:else}
      <p role="alert">Probe failed: {probeResult.message}</p>
    {/if}
  {/if}
</section>

{#if probeResult?.ok}
  <section>
    <h3>2. Record thumbnail</h3>
    {#key recordAttempt}
      <canvas bind:this={recordCanvas} height="180" width="320"></canvas>
    {/key}
    <button disabled={recording || refused} onclick={recordThumbnailForClip} type="button">
      {recording ? 'Recording…' : 'Record thumbnail'}
    </button>
    {#if captureError}
      <p role="alert">The recording failed, and the show did not notice: {captureError}</p>
    {/if}
    {#if thumbnailUrl}
      <video controls src={thumbnailUrl}>
        <track kind="captions" />
      </video>
      <p>Palette: {palette.join(', ')}</p>
      <p>Annotation frames: {stills.length}</p>
    {/if}
  </section>

  <section>
    <h3>3. Details</h3>
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
    <label class="check">
      <input bind:checked={modified} type="checkbox" />
      Modified from source
    </label>
    <label class="check">
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
    {#if stillsWarning}
      <p role="status">
        The clip is saved, but its frames were not uploaded, so it will be annotated from its code alone: {stillsWarning}
      </p>
    {/if}
  </section>
{/if}

<style>
  section {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin-top: 0.6rem;
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

  .check {
    align-items: center;
    flex-direction: row;
    gap: 0.3rem;
  }

  canvas,
  video {
    background: #05060a;
    display: block;
    max-width: 100%;
  }

  p {
    font-size: 0.74rem;
    margin: 0.2rem 0;
  }

  .refusal {
    font-weight: 700;
  }
</style>
