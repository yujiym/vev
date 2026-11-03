<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { env } from '$env/dynamic/public'

  import { resolveSourceLink } from './source.ts'

  const commit = env.PUBLIC_GIT_COMMIT ?? 'dev'
  const link = resolveSourceLink(env.PUBLIC_SOURCE_URL, commit)
</script>

<footer>
  {#if link.kind === 'link'}
    <a href={link.href} rel="noreferrer" target="_blank">
      Source ({commit})
    </a>
  {:else}
    <span>Source link not configured — set PUBLIC_SOURCE_URL</span>
  {/if}
  — vev is free software under AGPL-3.0-or-later.
</footer>
