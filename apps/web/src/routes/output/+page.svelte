<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { sendHello, subscribeOutput } from '$lib/output-client.ts'
  import type { Clock } from '@vev/engines'

  // `packages/engines`'s root barrel is pure logic (safe anywhere), but its
  // `./hydra` subpath pulls in `hydra-synth`, which touches `window` at module
  // load time — so it is imported dynamically below, inside the effect, never
  // at module scope (this file is the one place in vev that renders, per
  // spec §12.2/§3).
  type HydraCompositor = import('@vev/engines/hydra').HydraCompositor

  let canvas: HTMLCanvasElement | undefined = $state()

  $effect(() => {
    if (!canvas) {
      return
    }

    const currentCanvas = canvas
    let disposed = false
    let frame: number | undefined
    let compositor: HydraCompositor | undefined

    // A mutable object, not a value copied into the compositor: `onClock`
    // below mutates its fields in place, so a tempo change is visible to
    // `HydraCompositor`'s next `fadeProgress` call without reconstructing it.
    const clock: Clock = { beatsPerBar: 4, bpm: 120, downbeatAt: Date.now() }

    const resize = (): void => {
      currentCanvas.width = window.innerWidth
      currentCanvas.height = window.innerHeight
    }
    resize()
    window.addEventListener('resize', resize)

    const unsubscribe = subscribeOutput({
      onClock: (message) => {
        clock.beatsPerBar = message.beatsPerBar
        clock.bpm = message.bpm
        clock.downbeatAt = message.downbeatAt
      },
      onLoad: (message) => {
        compositor?.load(message.slot, message.clip.code)
      },
      onSwitch: (message) => {
        compositor?.switchTo(message.to, message.transition, message.at)
      },
    })

    const loop = (): void => {
      compositor?.tick(Date.now())
      frame = requestAnimationFrame(loop)
    }

    void (async () => {
      const { HydraCompositor: HydraCompositorClass } = await import('@vev/engines/hydra')
      if (disposed) {
        return
      }

      compositor = new HydraCompositorClass(clock)
      compositor.mount(currentCanvas)
      sendHello()
      frame = requestAnimationFrame(loop)
    })()

    return () => {
      disposed = true
      window.removeEventListener('resize', resize)
      unsubscribe()
      if (frame !== undefined) {
        cancelAnimationFrame(frame)
      }
      compositor?.dispose()
    }
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
