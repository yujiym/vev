<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->
<script lang="ts">
  import type { Control } from '../control.ts'
  import type { Live, LiveView } from '../live.ts'
  import { createLive } from '../live.ts'
  import type { MenuAction, OverlayId, StagePanel } from '../stage-view.ts'
  import { menuSections, NO_PANEL, registrationGate, stageNotices, togglePanel } from '../stage-view.ts'
  import { guardReload, keyTargetOf, toggleFullscreen, watchFullscreen } from '../stage-window.ts'
  import { startStage } from '../stage.ts'
  import CandidateCards from './CandidateCards.svelte'
  import ControlRow from './ControlRow.svelte'
  import InfoOverlays from './InfoOverlays.svelte'
  import Chat from './panels/Chat.svelte'
  import Library from './panels/Library.svelte'
  import NewClip from './panels/NewClip.svelte'
  import Panel from './panels/Panel.svelte'
  import Playlist from './panels/Playlist.svelte'
  import TrackEditor from './panels/TrackEditor.svelte'
  import Tracks from './panels/Tracks.svelte'

  /**
   * The one screen: the projected picture, with every control over it (ADR 0012). Wiring only. What
   * it renders is decided in `client/stage-view.ts`, `client/live.ts` and `client/control.ts`, because
   * templates are outside the type and lint gate (ADR 0001).
   */

  let canvas: HTMLCanvasElement | undefined = $state()
  let view = $state.raw<LiveView | undefined>()
  let control = $state.raw<Control | undefined>()
  let live = $state.raw<Live | undefined>()
  let pictureFault = $state<string | undefined>()

  let panel = $state.raw<StagePanel>(NO_PANEL)
  let cardsShown = $state(true)
  let overlays = $state<Record<OverlayId, boolean>>({
    code: false,
    credit: false,
    keys: false,
    status: false,
  })
  let fullscreen = $state(false)
  let menuOpen = $state(false)
  let rowHeight = $state(32)

  /** Mounted on first use and kept, so a form survives closing its panel with half a clip typed into it. */
  let newClipOpened = $state(false)
  let editingTrack = $state<string | undefined>()

  const notices = $derived(view === undefined ? [] : stageNotices(view, pictureFault))
  const gate = $derived(view === undefined ? ({ kind: 'allowed' } as const) : registrationGate(view.control))

  const sections = $derived(
    menuSections({
      cardsShown,
      directed: view?.live.direction !== undefined,
      fullscreen,
      overlays,
      panel,
    }),
  )

  const openPanel = (requested: StagePanel): void => {
    panel = togglePanel(panel, requested)
    if (panel.kind === 'new-clip') {
      newClipOpened = true
    }
    if (panel.kind === 'track-editor') {
      editingTrack = panel.id
    }
  }

  /** Choosing from the menu closes it, so what it opened is not left under its popover. */
  const chooseFromMenu = (action: MenuAction): void => {
    menuOpen = false
    switch (action.kind) {
      case 'cards': {
        cardsShown = !cardsShown
        break
      }
      case 'fullscreen': {
        void toggleFullscreen()
        break
      }
      case 'overlay': {
        overlays[action.id] = !overlays[action.id]
        break
      }
      case 'panel': {
        openPanel({ kind: action.panel })
        break
      }
      default: {
        break
      }
    }
  }

  $effect(() => {
    if (canvas === undefined) {
      return
    }

    let cancelled = false
    let teardown: (() => void) | undefined
    const stageCanvas = canvas

    void (async () => {
      const started = await startStage({
        canvas: stageCanvas,
        onPictureFault: (message) => {
          pictureFault = message
        },
      })
      if (cancelled) {
        started.stop()
        return
      }

      const session = createLive({
        control: started.control,
        onChat: () => {
          openPanel({ kind: 'chat' })
        },
        onCloseMenu: () => {
          menuOpen = false
        },
        onClosePanel: () => {
          panel = NO_PANEL
        },
      })
      ;({ control } = started)
      live = session

      const unsubscribe = session.subscribe((nextView) => {
        view = nextView
      })
      const onKey = (event: KeyboardEvent): void => {
        const handled = session.key(
          {
            altKey: event.altKey,
            ctrlKey: event.ctrlKey,
            key: event.key,
            metaKey: event.metaKey,
            shiftKey: event.shiftKey,
            target: keyTargetOf(event.target),
          },
          { menuOpen, panelOpen: panel.kind !== 'none' },
        )
        if (handled) {
          event.preventDefault()
        }
      }
      window.addEventListener('keydown', onKey)
      const unguard = guardReload()
      const unwatch = watchFullscreen((isFullscreen) => {
        fullscreen = isFullscreen
      })

      teardown = () => {
        unwatch()
        unguard()
        window.removeEventListener('keydown', onKey)
        unsubscribe()
        session.stop()
        started.stop()
        control = undefined
        live = undefined
        view = undefined
      }
    })()

    return () => {
      cancelled = true
      teardown?.()
    }
  })
</script>

<div class="stage" style:--row-height="{rowHeight}px">
  <h1 class="sr-only">vev stage</h1>
  <canvas bind:this={canvas}></canvas>

  {#if view?.control.panic === 'blackout'}
    <div class="blackout"></div>
  {/if}

  <div bind:clientHeight={rowHeight} class="row-holder">
    <ControlRow
      {control}
      {live}
      {menuOpen}
      onMenu={() => (menuOpen = !menuOpen)}
      onMenuChoose={chooseFromMenu}
      {sections}
      {view}
    />
  </div>

  <div class="under-row">
    {#if notices.length > 0}
      <ul class="notices">
        {#each notices as notice (notice.text)}
          <li class={notice.tone} role="status">{notice.text}</li>
        {/each}
      </ul>
    {/if}
    {#if view}
      <InfoOverlays {overlays} {view} />
    {/if}
  </div>

  {#if view}
    {#if cardsShown}
      <CandidateCards {live} {view} />
    {/if}
  {/if}

  {#if panel.kind === 'playlist'}
    <Panel onClose={() => (panel = NO_PANEL)} title="Playlist">
      <Playlist {control} {live} {view} />
    </Panel>
  {:else if panel.kind === 'library'}
    <Panel onClose={() => (panel = NO_PANEL)} title="Library">
      <Library onNewClip={() => openPanel({ kind: 'new-clip' })} />
    </Panel>
  {:else if panel.kind === 'tracks'}
    <Panel onClose={() => (panel = NO_PANEL)} title="Tracks">
      <Tracks onEdit={(id) => openPanel({ id, kind: 'track-editor' })} />
    </Panel>
  {:else if panel.kind === 'chat'}
    <Panel onClose={() => (panel = NO_PANEL)} title="Steering">
      <Chat {live} {view} />
    </Panel>
  {/if}

  {#if newClipOpened}
    <Panel hidden={panel.kind !== 'new-clip'} onClose={() => (panel = NO_PANEL)} title="New clip">
      <NewClip {gate} />
    </Panel>
  {/if}
  {#if editingTrack !== undefined}
    <Panel hidden={panel.kind !== 'track-editor'} onClose={() => (panel = NO_PANEL)} title="Track editor">
      {#key editingTrack}
        <TrackEditor id={editingTrack} onBack={() => openPanel({ kind: 'tracks' })} />
      {/key}
    </Panel>
  {/if}
</div>

<style>
  :global(html, body) {
    background: #000;
    color: #f4f6fa;
    font-family:
      ui-sans-serif,
      system-ui,
      -apple-system,
      'Segoe UI',
      sans-serif;
    margin: 0;
    overflow: hidden;
  }

  canvas {
    display: block;
    height: 100vh;
    left: 0;
    position: fixed;
    top: 0;
    width: 100vw;
  }

  .blackout {
    background: #000;
    inset: 0;
    position: fixed;
    z-index: 5;
  }

  .sr-only {
    height: 1px;
    margin: -1px;
    overflow: hidden;
    position: absolute;
    width: 1px;
  }

  /* The row wraps on a narrow screen, and the overlays and panels start below it. */
  .row-holder {
    left: 0;
    pointer-events: none;
    position: fixed;
    right: 0;
    top: 0;
    z-index: 30;
  }

  /* Notices and overlays stack here, so neither can sit on top of the other. */
  .under-row {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    left: 0.4rem;
    max-width: min(34rem, calc(100vw - 0.8rem));
    pointer-events: none;
    position: fixed;
    top: var(--row-height, 2rem);
    z-index: 10;
  }

  .notices {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .notices li {
    background: rgb(8 10 14 / 86%);
    border-left: 3px solid #6ef2c0;
    border-radius: 0.2rem;
    color: #f4f6fa;
    font-size: 0.68rem;
    padding: 0.15rem 0.4rem;
    width: fit-content;
  }

  .notices .warn {
    border-left-color: #ffb454;
  }

  .notices .bad {
    border-left-color: #ff6470;
    font-weight: 700;
  }
</style>
