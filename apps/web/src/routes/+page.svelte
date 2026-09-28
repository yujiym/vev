<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import { healthResponseSchema } from '@vev/shared'
  import type { HealthResponse } from '@vev/shared'
  import * as v from 'valibot'

  let health = $state<HealthResponse | undefined>()
  let errorMessage = $state<string | undefined>()

  const check = async (): Promise<void> => {
    try {
      const response = await fetch('/api/health')
      health = v.parse(healthResponseSchema, await response.json())
      errorMessage = undefined
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : 'unknown error'
    }
  }
</script>

<h1>vev</h1>

<button onclick={check} type="button">Check API</button>

{#if health}
  <p>mode: {health.mode} · settings rows: {health.settingsRows} · commit: {health.commit}</p>
{:else if errorMessage}
  <p>API unreachable: {errorMessage}</p>
{/if}
