<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0012: One screen, at the root route

Supersedes the two-window arrangement of §3 as built in M1, and ADR 0004's message contract. ADR 0004's rule stands: the reducer decides, the renderer executes, and the seam between them has its own test.

## Context

A performer watched two windows: the picture on the projector, and a control screen beside it. The maintainer wants to perform from the picture itself, with candidates small along its bottom edge and everything else called up over it. Three things were decided before any code: the UI is overlaid directly on the projection and the audience sees it; choosing a candidate switches on the next bar with no Go; and candidates are always visible, with one button that hides them.

Every path in the app was `/studio/*` or `/output`, and navigating away unmounts the compositor, so the library and the editors could not stay pages. The maintainer then asked for the output to be the top of the app, at `/`.

## Decision

**The stage is `/`, and it is the only screen.** `pages/index` mounts `client/stage/Stage.svelte`. The library, new clip, tracks, track editor, playlist and chat are panels on it. `/studio`, `/studio/*` and `/output` are gone as pages and answer a `302` to `/` through `routing.redirects` in `void.config.ts`: three lines, no page and no middleware, and `scripts/smoke-live.sh` asserts them.

**The window boundary is deleted, not bridged.** `BroadcastChannel`, `output-channel.ts`, `outputMessageSchema`, `sendHello`, `handleHello`, `subscribeOutput` and `startOutput` are gone. Nothing crosses a document, so nothing is untrusted and nothing needs a schema.

**`pendingSwitch` goes too.** It existed because a `switch` message had to travel ahead of its bar, and the output had to hold it until then. With one loop, the reducer's `tick` already knows when the bar arrives, so `createControl` calls `picture.switchTo` on that frame, and a held copy would only be a second schedule that could disagree. All of it passes through `dispatch`, which reduces and then projects the difference onto the picture. A transition changed between the press and the bar needs no re-send, because it is read when the switch fires. ADR 0004's seam test moved with it: `control.test.ts`'s `the picture obeys the reducer` holds a fake `Picture` to "not a frame before the bar".

**One clock object.** The reducer reads it, the compositor fades against it, and a tap moves it in place.

**A choice is one reducer event, `choose`, with a case per state.** Idle: stage the clip in the free slot and arm the next bar. Armed: replace the clip and keep the bar. Fading: hold it in `chosen`, and arm it when the fade lands, because there is no free slot until then. Choosing the clip that is already armed, or already held, takes the choice back: the armed switch or the held choice is dropped, `held` is left as the performer set it, and the picture carries on. The reducer cannot tell an armed Go from an armed choice, so either is cancelled by choosing its clip again. Hold pressed after a choice made in a fade survives the landing, because it pauses automatic advance and does not cancel a switch that was asked for; the choice still arms its bar. `select-next` already replaced a clip while armed, despite what the brief for this change assumed; what was missing was arming in the same event, and a clip's readiness resetting with it.

**A switch never fires onto a slot that has not rendered.** `next.ready` is false until the slot has drawn two frames, and at the bar `tick` slips an unready switch to the following bar. A Go now waits for the first frame it can fire on instead, and its fade starts there. The rule is a fact about the buffer rather than a lead time, so it also covers a shader compile that stalls past any margin. Back obeys it too: it reloads the previous clip into the free slot and cuts after two frames, and a clip staged in that window loads only after the cut, because its slot is the one still on screen until then. A second Back is refused for those frames.

**A clip that did not compile never reaches a slot.** Hydra's `.out()` catches its own errors, so `load` used to return normally for a shader WebGL then refused, and two frames later the slot was marked ready. `load` now fails when the slot's draw command was not replaced, or when one draw into it raises a WebGL error, and the control remembers the code it refused so it is compiled once.

**Freeze holds a switch.** An armed switch slips past its bars while frozen, so `current` never names a clip nobody can see. Blackout does not hold one, because the picture keeps rendering underneath.

**Thumbnails hold a paused first frame**, with `preload="metadata"`, and play on hover or focus. That goes for the library panel's grid too, which used to autoplay every clip.

**The row keeps the performer's controls and the rest sit behind a Menu.** The audience sees the row, so it holds Hold, Back, Go, Go now, the transition, Blackout, Freeze, TAP with the tempo, Auto and the decision indicator, then one Menu button. The panels, Cards, the overlay toggles and Fullscreen are in the Menu with their state in words. It opens below the row so panic stays one click away, and `Esc` closes it before a panel and before Freeze. `menuSections` in `client/stage-view.ts` decides what it lists, so the template decides nothing. Buttons are near-opaque and a disabled one keeps light text, measured at 8.82:1 over a white clip where it was 3.95:1.

**The screen is told at most ten times a second on an uneventful frame.** A change of state still notifies at once. Svelte and the compositor share one thread now, so a render per frame would be a cost the show pays.

**A registration probe or recording refuses while a switch is armed or fading**, and otherwise runs under a standing warning in the panel. The stage is always playing, so "refuse during a show" would mean never, and the screen cannot tell whether an audience is present.

**A reload keeps what an audience would notice**, in `sessionStorage`: the clip on screen, the tempo and bar grid, and a blackout. A `beforeunload` prompt asks first. `client/show-memory.ts` is about seventy lines. The track, its position, candidates, the direction and the history do not survive, and Freeze does not, because the frame it held is gone with the canvas.

## Alternatives

- **Keep `startOutput` and its `pendingSwitch`, calling it in-process.** It would have kept tests unchanged, but the hold would be a second schedule beside the reducer's, re-published on every change, and the slip rule would need to reach into it. Rejected: it is a compatibility layer for a boundary that no longer exists.
- **Rely on a synchronous load and fire on the bar regardless.** Hydra was tried in a real browser first. A clip loaded and cut to in the same frame showed two frames of black, and into a reused slot two frames of the clip it replaced (`o0` samples a buffer before that buffer's own draw, and from before its last one):

  ```
  settled:      255,0,0,255
  new slot:     0,0,0,0 | 0,0,0,0 | 0,255,0,255 | 0,255,0,255
  reused slot:  255,0,0,255 | 255,0,0,255 | 0,0,255,255 | 0,0,255,255
  ```

- **A fixed lead time before the bar.** Simpler to say, but it guesses at how long a compile takes on hardware nobody here has measured.
- **Persisting the whole show.** The reducer state and the track cursor would serialise, but replaying them needs the fade, the track and the candidates reconciled, which is more than a small change. Recorded in §17.
- **Rebuilding the compositor on a lost context.** Not built. A lost context puts a notice on screen and a reload brings the picture back. Recorded in §17.

## Evidence

From a real `pnpm live`, in Chromium under SwiftShader, unless noted.

- All six browser drivers pass (`apps/app/e2e/`), including `1`/`2`/`3`, `Shift+Space`, a card clicked during a real fade, a reload under blackout, a thumbnail showing its first frame paused, and a lost registration context leaving the picture moving.
- Reducer tests for the new events failed first (15 failed, 54 passed) and pass now. The review round's fixes each failed first too: the cancel and Hold cases in the reducer (4 failed), a Back followed by a staged clip, a refused clip compiled twelve times in sixty frames, a recording whose clip will not load leaving its context behind, a non-finite stored downbeat, and a shader that will not link, which `playback.mjs` caught on the build before the fix (no `did not load` notice, Go still enabled). Each new rule in the control, the live layer and the view was mutated and a test failed.
- `dist/ssr` holds no `hydra-synth`.
- An unauthenticated `curl` on 2026-11-03 found `vev-preview.0x7.sh` redirecting `/`, `/studio`, `/output`, `/api/health`, `/media/x` and `/t/x` alike to the Access login. Access covers that whole hostname, so moving the stage to `/` needs no policy change there. §13 had described a path list, and now says what is deployed.

## Consequences

- **The audience sees the UI.** Every button, card, title and the code overlay is on the projection. Overlays are off by default for that reason, and the row now holds only what a performer needs in the moment. It is one line from 1280 down to about 730 wide and wraps below that. Nothing here makes a mistake private, and a click on Menu is still visible.
- **A reload stops the show's state.** A stray reload is now the show's main risk, where before it cost only the control screen. The prompt and the small memory reduce it; they do not remove it. A loaded track has to be loaded again.
- **Registration shares the GPU.** A probe compiles and reads pixels synchronously on the show's thread, and a recording renders a second Hydra for three seconds beside the live one. Either can hitch the picture, and the probe's frame-budget number now competes with the show. How much is unmeasured: Chromium here renders in software. The clean answer stays "register before the doors open".
- **`Esc` belongs to the browser in fullscreen.** Keyboard Lock gives it back in Chromium and nowhere else; this has not been seen working on a real display.
- **`/` is the owner's.** §0 describes `vev.0x7.sh` as a public site. Its docs and demo tracks now need a home other than `/`, or a host of their own (§17).
