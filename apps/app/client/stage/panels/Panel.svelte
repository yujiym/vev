<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { Snippet } from 'svelte'

  const {
    children,
    hidden = false,
    onClose,
    title,
  }: { children: Snippet; hidden?: boolean; onClose: () => void; title: string } = $props()
</script>

<aside aria-label={title} class="panel" {hidden}>
  <header>
    <h2>{title}</h2>
    <button onclick={onClose} type="button">Close</button>
  </header>
  <div class="body">
    {@render children()}
  </div>
</aside>

<style>
  /* Beside the picture rather than over all of it, and below the control row, so panic is one click away. */
  .panel {
    background: rgb(10 12 16 / 92%);
    border-left: 1px solid rgb(255 255 255 / 25%);
    bottom: 1.5rem;
    color: #f0f3f8;
    display: flex;
    flex-direction: column;
    font-size: 0.8rem;
    max-width: 100vw;
    position: fixed;
    right: 0;
    top: var(--row-height, 2rem);
    width: 32rem;
    z-index: 20;
  }

  .panel[hidden] {
    display: none;
  }

  header {
    align-items: center;
    border-bottom: 1px solid rgb(255 255 255 / 18%);
    display: flex;
    justify-content: space-between;
    padding: 0.4rem 0.6rem;
  }

  h2 {
    font-size: 0.8rem;
    letter-spacing: 0.08em;
    margin: 0;
    text-transform: uppercase;
  }

  .body {
    flex: 1;
    overflow: auto;
    padding: 0.6rem;
  }

  .panel :global(button),
  .panel :global(select),
  .panel :global(input),
  .panel :global(textarea) {
    background: #171b23;
    border: 1px solid #3a4252;
    border-radius: 0.3rem;
    color: #eef1f6;
    font: inherit;
    padding: 0.2rem 0.4rem;
  }

  .panel :global(button) {
    cursor: pointer;
  }

  .panel :global(button:disabled),
  .panel :global(select:disabled) {
    color: #8b93a1;
    cursor: not-allowed;
  }

  .panel :global(a) {
    color: #8fd8ff;
  }

  .panel :global(.dim) {
    color: #aab2c0;
    font-size: 0.72rem;
  }

  .panel :global(.warning) {
    color: #ffb454;
  }

  .panel :global([role='alert']) {
    color: #ff8a8a;
  }
</style>
