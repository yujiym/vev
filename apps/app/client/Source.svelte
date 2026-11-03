<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { resolveSourceLink } from './source.ts'

  const { commit, sourceUrl }: { commit: string; sourceUrl: string } = $props()

  const link = $derived(resolveSourceLink(sourceUrl, commit))
</script>

<footer>
  {#if link.kind === 'link'}
    <a href={link.href} rel="noreferrer" target="_blank">
      Source ({commit})
    </a>
  {:else}
    <span>Source link not configured — set SOURCE_URL</span>
  {/if}
  — vev is free software under AGPL-3.0-or-later.
</footer>

<style>
  /* A corner of the stage rather than a page footer: the AGPL §13 offer stays on screen (§14.1). */
  footer {
    background: rgb(8 10 14 / 70%);
    border-radius: 0.25rem;
    bottom: 0.3rem;
    color: #e6eaf1;
    font-size: 0.6rem;
    padding: 0.1rem 0.35rem;
    position: fixed;
    right: 0.4rem;
    z-index: 30;
  }

  a {
    color: #bfe6ff;
  }
</style>
