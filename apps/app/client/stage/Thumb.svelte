<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { playThumbnail } from '../stage-window.ts'

  const { active = false, src }: { active?: boolean; src: string | undefined } = $props()

  let video: HTMLVideoElement | undefined = $state()
  let hovered = $state(false)

  // A paused first frame until someone looks at it: every playing thumbnail is one more video decode
  // on the GPU the show is rendering on (ADR 0012).
  $effect(() => {
    if (video === undefined) {
      return
    }
    if (active || hovered) {
      void playThumbnail(video)
    } else {
      video.pause()
    }
  })
</script>

{#if src}
  <video
    bind:this={video}
    loop
    muted
    onpointerenter={() => (hovered = true)}
    onpointerleave={() => (hovered = false)}
    playsinline
    preload="metadata"
    {src}
  ></video>
{:else}
  <span class="none">no thumbnail</span>
{/if}

<style>
  video,
  .none {
    aspect-ratio: 16 / 9;
    background: #05060a;
    display: block;
    object-fit: cover;
    width: 100%;
  }

  .none {
    align-items: center;
    color: #a4acba;
    display: flex;
    font-size: 0.62rem;
    justify-content: center;
  }
</style>
