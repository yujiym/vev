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
