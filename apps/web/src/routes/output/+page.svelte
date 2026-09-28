<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { startOutput } from '$lib/output-client.ts'

  let canvas: HTMLCanvasElement | undefined = $state()
  let startupError = $state<string | undefined>()

  $effect(() => {
    if (!canvas) {
      return
    }

    startupError = undefined
    return startOutput({
      canvas,
      onStartupError: () => {
        startupError = 'Output failed to start — check the console and reload.'
      },
    })
  })
</script>

<canvas bind:this={canvas}></canvas>
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

  .startup-error {
    color: #f66;
    font: 14px monospace;
    left: 1rem;
    margin: 0;
    position: fixed;
    top: 1rem;
  }
</style>
