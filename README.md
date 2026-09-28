<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# vev

**AI-assisted live visual sequencer.** _The model suggests; you decide._

vev is a web app for VJ performance. It chains visual clips you have saved — live-coded sketches, not video files — and a decision model proposes about three candidates for what should come next. The top one plays by default; you can override it with a click at any moment, and steer the whole direction in words.

It is built around three commitments:

- **The model suggests, the human decides.** Auto-advance is a default, never a lock. The chat steers what gets offered; it never touches the transport.
- **Never stop the show.** If the backend, the decision model or the network fails, playback continues — the fallback chain ends at "play something", not at an error.
- **Local-first.** Venue networks fail. vev runs the same built artifact on a laptop with no internet, from local storage, with a local decision model.

Free software, self-hosted: there is no shared service to sign up for. You deploy vev to your own Cloudflare account, or run it on your own machine.

## Status

**Early. M0 and M1.** The scaffold is built and verified: the workspace, the Hono Worker with D1, the SvelteKit SPA it serves, and the CI gate. Playback exists now, in its smallest form: a pure reducer decides when a switch happens, a Hydra compositor renders it, and a control window and a separate output window stay in sync over `BroadcastChannel` by sharing a wall-clock timestamp rather than trusting message delivery time — including recovering a switch already in progress if the output window reloads mid-show. Two fixture clips — not a library — switch with a cut or a 2-bar crossfade, the only two transitions built so far (§9.1 lists more; they are not written). Control is a debug panel, not the control screen of §12.1: buttons, no candidates, no chat. There is no clip library, no decision model, and no candidate ranking yet. Everything past that is designed, not written.

[`docs/spec.md`](docs/spec.md) is the specification and the authority; its §18 tracks what is built against what is planned. Nothing in this README describes a feature that does not exist.

## Quick start

```sh
pnpm install --frozen-lockfile
pnpm dev     # development: SPA on :5173, API on :8787
pnpm live    # the built app, served by the local Worker on :8787 — the venue shape
```

Commands, prerequisites and the traps worth knowing are in [`docs/runbook.md`](docs/runbook.md).

## Documentation

|                                      |                                                        |
| ------------------------------------ | ------------------------------------------------------ |
| [`docs/spec.md`](docs/spec.md)       | What vev is and how it should work — the authority     |
| [`docs/adr/`](docs/adr/README.md)    | Why the code is shaped this way, with the evidence     |
| [`docs/runbook.md`](docs/runbook.md) | How to run it, and what bites                          |
| [`AGENTS.md`](AGENTS.md)             | Guidance for AI coding agents working here             |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | DCO sign-off, the quality gate, what it does not cover |

## License

**AGPL-3.0-or-later** for the whole repository. `hydra-synth`, which vev bundles into the JavaScript it serves, is AGPL-3.0; licensing everything the same way keeps it simple and keeps modified public deployments sharing their changes. Every page carries a link to the source of the exact commit it is running, as AGPL §13 requires — if you modify vev and deploy it, point that link at your fork.

**Clips are content, not code.** They keep their authors' licenses, and this repository ships none but its own examples. License, author and source travel with every clip, through the set list and the credits. See §14 of the spec.
