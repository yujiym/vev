<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# 0010: Annotation from rendered stills as well as code

Extends [ADR 0005](0005-annotation-as-typed-questions.md). ADR 0005's typed questions, its tag vocabulary and its rule that `palette` is read from rendered pixels all stand. What changes is the evidence the typed questions are judged against.

## Context

ADR 0005 asked `typesafe/jev` about a clip's source code alone, because spec §11 records that still frames lead to wrong judgements about motion. That left jev blind to how a clip looks: how dense it is, whether it reads as a background or a foreground layer, its colour and form. Code says little about those, and they are the fields the decision layer filters on.

TypeSafe added image input to jev. It was observed on 2026-11-03 through `cf ai run typesafe/jev-1.14.0`. The request names each image by key in `state` and carries the bytes in `assets`. It takes PNG or JPEG stills only, 280 to 1568 pixels a side, 78,400 to 2,458,624 pixels in all, 16 MiB an image and 32 MiB a request, inside the 32,000-token context. Images cost about 450 input tokens each. TypeSafe labels the feature beta. A 320x180 image is refused with `Invalid image dimensions`, and the registration canvas is 320x180.

## Decision

The browser takes three JPEG stills during the thumbnail recording, resized to 512x288, and uploads them after registration. The queue consumer loads them from R2 and sends them to jev with the code.

- **Capture.** `captureThumbnail` copies the canvas onto a small 2D canvas with `drawImage` inside the render tick, at one sixth, one half and five sixths of the recording. This follows the rule in `palette.ts`: a WebGL canvas with `preserveDrawingBuffer: false` is only readable in the tick that drew it. Only the JPEG encoding is asynchronous, and it runs on the copies. Any failure drops a frame and never the thumbnail, the palette or the registration.
- **Storage.** `POST /api/clips/:id/stills` takes up to three JPEGs as multipart parts, stores them in R2 under `stills/<clip id>/<n>.jpg` and records the keys in a nullable JSON column, `clips.still_keys`, in one update. It checks each part's magic bytes and size. The public media route does not serve stills.
- **Questions.** `density`, `layerHint`, `energy` and the visual tags are asked with the frames and the code. `motion` is asked in the same call but its instructions say to judge from the code, and the brief says the same of anything that depends on movement. `feedback` and `audio-reactive` stay derived from `deps`. One call keeps the cost of the frames to their tokens.
- **Fallback.** A clip with stills makes its first attempt with them and its second, if the first fails or returns something unusable, with the code alone. A clip without stills makes two code-only attempts as before. Either way it is at most two jev calls, each under the existing 30 second timeout, and `annotateClip` records which evidence produced the answer (`stills` or `code`) and how long the call took. Only when both attempts fail is the clip marked `failed`.
- **Retriggering.** The stills route enqueues annotation again once the keys are stored, because registration has already enqueued it before any still existed. §17 records this as a default and not a settled decision.

## Consequences

- Registration never depends on stills. A browser that cannot capture them, an upload that fails, a missing R2 object and a refused image call all end in a clip annotated from its code, as before.
- A clip with stills is annotated twice. The second run is the one that sees the frames, and it overwrites the first.
- The canvas is enlarged to reach 512x288, so the stills carry no more detail than the 320x180 canvas drew. They satisfy jev's limits; they do not add resolution.
- `askJev` takes an optional list of images and sends a plain string `state` when there are none, so a caller that passes none is unchanged. The wire spelling of images stays in `jev.ts`.
- Whether stills make annotation more accurate is unmeasured (§17). The tag vocabulary still includes four tags about change over time, and nothing yet shows that jev judges them from the code when frames are attached.
- Nothing displays the stills. They exist only to be sent to jev.
