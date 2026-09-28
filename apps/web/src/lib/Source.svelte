<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { env } from '$env/dynamic/public'

  import { sourceCommitUrl } from './source.ts'

  const sourceUrl = env.PUBLIC_SOURCE_URL ?? 'https://github.com/oboroxyz/vev'
  const commit = env.PUBLIC_GIT_COMMIT ?? 'dev'
</script>

<footer>
  <a href={sourceCommitUrl(sourceUrl, commit)} rel="noreferrer" target="_blank">
    Source ({commit})
  </a>
  — vev is free software under AGPL-3.0-or-later.
</footer>
