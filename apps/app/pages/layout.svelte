<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { useShared } from '@void/svelte'

  import Source from '../client/Source.svelte'

  const { children } = $props()
  const shared = useShared()
</script>

{@render children()}

<Source commit={shared.commit} sourceUrl={shared.sourceUrl} />
