<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { Link } from '@void/svelte'

  const { path }: { path: string } = $props()
</script>

<h1>Not found</h1>

<p>Nothing lives at <code>{path}</code>.</p>

<p><Link href="/">Back to vev</Link></p>
