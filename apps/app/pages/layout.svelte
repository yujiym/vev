<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import Source from '$lib/Source.svelte'

  const { children } = $props()
</script>

{@render children()}

<Source />
