<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { startOutput } from '$lib/output-client.ts'

  let canvas: HTMLCanvasElement | undefined = $state()

  $effect(() => {
    if (!canvas) {
      return
    }

    return startOutput({ canvas })
  })
</script>

<canvas bind:this={canvas}></canvas>

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
</style>
