<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0005: Annotation as typed questions, not generated prose

## Context

Spec §11 says ingestion annotates a clip with `description`, `tags`, `palette`, `energy`, `motion`, `density` and `layerHint`, and §4's tech-stack table said only "LLM ... ingestion annotation (queue consumer)". That leaves the shape of the call open, and the obvious reading — ask a chat model to describe the clip and parse seven fields out of its prose — is the one M2 had to decide against before writing the consumer.

The forcing fact is what these fields are actually _for_. Six of the seven are not prose at all:

- `energy` is a 1-5 integer that §16's transition rules do arithmetic on ("energy +2 or more", "within ±1").
- `motion`, `density` and `layerHint` are closed enums, declared once in `packages/shared` (`clipMotionSchema`, `clipDensitySchema`, `clipLayerHintSchema`) and stored as-is.
- `tags` is the axis the library filters on today (`GET /api/clips?tag=`) and the axis M3's candidate pipeline filters and scores on tomorrow.
- `palette` is a list of hex colours.

A generative model answers all of those in words, and words drift. "kaleid" one run, "kaleidoscope" the next, "kaleidoscopic" the third; `energy: "high"` where the column is an integer; a `layerHint` of `"background"` where the enum says `bg`. A library filtered on drifting text quietly stops finding things — not with an error, which would be recoverable, but with a shorter result list nobody questions. M3's search is built directly on top of these fields, so the drift would land in the one place where it is least visible and most expensive.

Cloudflare's Workers AI catalogue carries a model built for exactly this shape: `typesafe/jev`, which takes a `state` plus a map of **typed questions** — `score` (a zero-based level scale, answered as a float with a confidence), `choice` (option keys with descriptions, answered as one of the keys) and `noul` (a statement with true/false criteria, answered as a bare probability) — and returns typed answers under the ids that asked for them.

## Decision

**Ask most of a clip's annotation as typed questions, and generate only what genuinely needs generating.**

- `energy` is one `score` question over five written level descriptions (`ENERGY_LEVELS` in `apps/api/src/ingest/annotate.ts`). jev's levels are zero-based, so the answer is a float in 0-4 and `energyFromScore` is the single place it becomes spec §5's `1 | 2 | 3 | 4 | 5`.
- `motion`, `density` and `layerHint` are `choice` questions whose **option keys are the enum values from `@vev/shared`**, each paired with a description of what it means. The key is what makes the answer storable without drift; the description is what makes the question answerable. Tests assert the exact key sets, so an enum gaining a value fails loudly here rather than silently never being chosen.
- **Every tag is its own `noul` question** — a statement about what the clip's code makes the renderer do, plus what makes it true and what makes it false — and a clip's tags are the ones whose probability comes back above `TAG_THRESHOLD`. The vocabulary is fixed, written out in `apps/api/src/ingest/tags.ts`.
- **Two tags are never asked at all.** `feedback` and `audio-reactive` are facts about the source, derived statically at registration by `analyzeHydra` (`@vev/ingest`) into `deps.usesFeedback` / `deps.usesAudio`, and surfaced as tags by `derivedTags`. Asking a probabilistic model a question a parser already answers deterministically produces two answers with no tiebreaker.
- **`palette` is not asked of a model at all.** It is computed in the browser from the frames the clip actually rendered during thumbnail recording (`dominantColours`, `apps/web/src/lib/palette.ts`), and travels to the server with the thumbnail upload. The rendered pixels _are_ the colours; a model reading the source would be guessing at what `osc(4, 0.05, 0.2).color(0.2, 0.3, 0.5)` resolves to on screen, and §11 already records the related lesson that judging a clip from stills gets motion wrong.
- **`description` is the one field that genuinely needs generation**, because it is free text meant for a human to read and for M3 to embed. It goes to a separate, small text model — `@cf/qwen/qwen2.5-coder-32b-instruct`, chosen because the input is code — and it is **best effort**: if that call fails, the clip keeps every other annotation and `description` stays empty.

Everything that knows jev's wire shape lives in one module, `apps/api/src/ingest/jev.ts`. Callers describe questions with `scoreQuestion` / `choiceQuestion` / `noulQuestion` and read back decoded, range-checked answers; no other file constructs a jev request or touches a jev response.

## Consequences

- **The stored row cannot drift.** An answer outside the question — a score of 7 on a five-level scale, a `choice` of a key that was never offered — is rejected in `jev.ts` rather than written, so a malformed annotation fails the clip (`annotationStatus: 'failed'`) instead of poisoning the library with a value nothing filters on.
- **M3 can build search on these fields.** A fixed tag set is a stable filter axis and a stable input to a ranking rule; a generated one is not.
- **The fixed vocabulary cannot describe a clip nobody anticipated.** This is the real cost, and it is paid in full: eighteen statements were written before any clip was annotated, and a sketch that is none of those eighteen things gets an empty `tags` array and is findable only by its `description` (and, from M3, its embedding). Recognising that gap needs a human looking at the library, because nothing in the pipeline reports "this clip matched nothing".
- **Widening the vocabulary re-annotates the library.** Adding a tag adds a question, and the answer to that question does not exist for any clip already stored. Every existing clip must be re-enqueued for the new tag to mean anything, and a filter on it is wrong — silently, again — until that finishes. The vocabulary is therefore a schema-shaped decision, not a config tweak.
- **Neither `TAG_THRESHOLD` (0.6) nor the vocabulary's size (eighteen) is measured.** No clip has been annotated: the account holds no prepaid AI Gateway credits and `typesafe/jev` bills from them, so the call is rejected before it is served (§17). `TAG_THRESHOLD` is exported and the tests assert _relative_ to it, so the first tuning pass moves one number and breaks nothing.
- **jev's request and response shapes are documented, not confirmed.** They come from Cloudflare's model page, read 2026-09-29, and the one live attempt from this account never got past billing. Confining them to `jev.ts` is what bounds that risk: when credits land, one live call either confirms that file or changes that file, and nothing else in the repository moves.
- **Two models on the annotation path means two ways to be slow**, so each call carries its own timeout (30s for jev, 20s for the description call). Both numbers are guesses — see §17.
- **Annotation never blocks registration.** It runs off the `INGEST` queue, and a clip is stored `annotationStatus: 'pending'` the moment it is registered (§0 principle 2, §11.1). A clip that fails annotation is a usable clip missing its typed fields, not a lost one.

## Alternatives weighed

- **One generative call, JSON-schema-constrained.** Closer to the fields' real shape than free prose, and it would have kept the pipeline to a single model. Rejected because a constrained decode still leaves the _values_ free: a schema can require `tags: string[]`, but not that the strings come from one vocabulary, which is the precise property M3's search depends on. `noul` per tag makes the vocabulary the question rather than a hoped-for property of the answer.
- **Deriving everything statically from the code**, as `deps` already is. Rejected for the judgement fields: whether a sketch reads as "psychedelic" or sits at energy 4 is not recoverable from its AST. It _is_ how `feedback` and `audio-reactive` are derived, precisely because those two are not judgements.
- **Asking a model for the palette** alongside the other fields, saving a browser round trip. Rejected because the renderer already produced the ground truth; sampling it costs one `readPixels` inside a tick the registration screen was running anyway.
