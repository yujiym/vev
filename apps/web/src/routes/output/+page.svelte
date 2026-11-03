<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { startOutput } from '$lib/output-client.ts'

  let canvas: HTMLCanvasElement | undefined = $state()
  let startupError = $state<string | undefined>()
  let panic = $state<'blackout' | 'freeze' | 'none'>('none')

  $effect(() => {
    if (!canvas) {
      return
    }

    startupError = undefined
    return startOutput({
      canvas,
      onPanic: (mode) => {
        panic = mode
      },
      onStartupError: () => {
        startupError = 'Output failed to start — check the console and reload.'
      },
    })
  })
</script>

<canvas bind:this={canvas}></canvas>
{#if panic === 'blackout'}
  <div class="blackout"></div>
{/if}
{#if startupError}
  <p class="startup-error">{startupError}</p>
{/if}

<style>
  :global(html, body) {
    background: #000;
    margin: 0;
    overflow: hidden;
  }

  canvas {
    display: block;
    height: 100vh;
    width: 100vw;
  }

  .blackout {
    background: #000;
    inset: 0;
    pointer-events: none;
    position: fixed;
  }

  .startup-error {
    color: #f66;
    font: 14px monospace;
    left: 1rem;
    margin: 0;
    position: fixed;
    top: 1rem;
  }
</style>
