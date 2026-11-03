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

**Early: a show runs on localhost.** The scaffold is built and verified: the workspace, one Void application with D1, R2 and Queues, whose Svelte pages and Hono API are served by the same Worker, and the CI gate. Playback works in its smallest form: a pure reducer decides when a switch happens, a Hydra compositor renders it, and a control window and a separate output window stay in sync over `BroadcastChannel` by sharing a wall-clock timestamp rather than trusting message delivery — including recovering a switch already in progress if the output window reloads mid-show. Cut and a 2-bar crossfade are the only two transitions built (§9.1 lists more; they are not written).

M2 added the clip library. A Hydra sketch can be pasted in, validated by a probe that runs it in a real WebGL context — exactly one output, compiles, renders, not a black frame, inside a frame budget — recorded to a short thumbnail video in R2 with its colour palette read from the frames it actually drew, and saved to D1. Clips can be browsed and filtered, arranged into a saved track, and the track plays through the reducer with auto-advance. **The library exists but holds only what has been registered by hand** — nothing ships with clips, and there is no import from anywhere. Automatic annotation (tags, energy, motion, density, layer hint, description) reads the clip's code and three rendered frames. Its questions have run against the live model through `cf ai run`, but no call has gone through a deployed Worker yet, so a clip registered on `pnpm live` stays at `annotationStatus: "pending"`, because local mode has no model and no queue. See §17 of the spec.

Control is the screen of §12.1: a top bar with track, BPM, TAP, Auto and a decision indicator; NOW and NEXT with the transition that will run, changeable in one click; the track timeline with section labels; the steering chat with its standing direction and a Clear; three candidates with their reason, provenance and thumbnail video; and Hold, Back, Blackout and Freeze with the §12.1 keys. Candidates come from `POST /api/candidates`: a rule ranking over the library, with Workers AI's `typesafe/jev` layered on top when the binding answers. **That model layer has never been served** (§17), so what you will see is `rule ranking`. The chat is interpreted by the tag dictionary only; no LLM reads it. The performer always decides: nothing the chat or the candidates do moves the show. Not built: Safe clip, the output-monitor picture, audio input, session logging and the Downbeat button.

[`docs/spec.md`](docs/spec.md) is the specification and the authority; its §18 tracks what is built against what is planned. Nothing in this README describes a feature that does not exist.

## Quick start

```sh
pnpm install --frozen-lockfile
pnpm dev     # development: pages and API together on :8787, one process
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
