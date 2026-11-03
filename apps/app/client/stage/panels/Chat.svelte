<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { Live, LiveView } from '../../live.ts'

  const { live, view }: { live: Live | undefined; view: LiveView | undefined } = $props()

  let text = $state('')
  let input: HTMLTextAreaElement | undefined = $state()

  const direction = $derived(view?.live.direction)

  $effect(() => {
    input?.focus()
  })

  const send = (event: SubmitEvent): void => {
    event.preventDefault()
    live?.interpret(text)
    text = ''
  }
</script>

<div class="direction">
  {#if direction}
    <span class="direction-text">“{direction.text}”</span>
    <span class="provenance dim">{direction.source}</span>
    <button onclick={() => live?.clearDirection()} type="button">Clear</button>
  {:else}
    <span class="dim"
      >No standing direction. A message here steers what is offered; it never moves the show.</span
    >
  {/if}
</div>

<form onsubmit={send}>
  <textarea bind:this={input} bind:value={text} placeholder="darker, slower…" rows="3"></textarea>
  <button disabled={text.trim() === ''} type="submit">Send</button>
</form>

<style>
  .direction {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 0.6rem;
  }

  .direction-text {
    color: #b9ffe4;
    font-size: 0.95rem;
  }

  form {
    display: flex;
    gap: 0.4rem;
  }

  textarea {
    flex: 1;
    resize: vertical;
  }
</style>
