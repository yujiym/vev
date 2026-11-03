<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Browser drivers (manual)

Six scripts that open the stage in a real Chromium and assert on what is rendered. They exist because `.svelte` sits outside the type and lint gate (ADR 0001) and `vp build` proves only that a template parses and its imports resolve — it says nothing about whether a handler is wired to the right thing, or whether an `$effect` fires. Running these found two defects no unit test had.

**They are not part of `pnpm test` and not wired into CI, deliberately.** They need a running server and a browser download; making the gate depend on either would trade a fast check for a flaky one.

## Running them

Start the app first, in another terminal — the built app served by the local Worker, which is one origin for both the pages and the API:

```bash
pnpm live          # builds apps/app, then vp preview on 127.0.0.1:8787
```

Then, from the repository root:

```bash
npx --yes --package playwright@1.63.0 node apps/app/e2e/library.mjs
npx --yes --package playwright@1.63.0 node apps/app/e2e/editor.mjs
npx --yes --package playwright@1.63.0 node apps/app/e2e/playback.mjs
npx --yes --package playwright@1.63.0 node apps/app/e2e/live.mjs
npx --yes --package playwright@1.63.0 node apps/app/e2e/stills.mjs
npx --yes --package playwright@1.63.0 node apps/app/e2e/stage.mjs
```

If `npx` refuses with `EBADDEVENGINES` (the shell's `node` is not the one `package.json` pins), run it from a scratch directory with an absolute script path instead: `cd "$(mktemp -d)" && npx --yes --package playwright@1.63.0 node /path/to/vev/apps/app/e2e/live.mjs`.

`playwright@1.63.0` is pinned in that invocation on purpose; keep it, `lib.mjs`'s loader comment, and this line in step. **`playwright` is not a dependency of this repository and must not become one.**

`npx --package` puts playwright's _binary_ on `PATH` but sets no `NODE_PATH` — and ESM ignores `NODE_PATH` anyway — so a bare `import 'playwright'` from a file in this repository does **not** resolve under that invocation. Verified, not assumed: it fails with `ERR_MODULE_NOT_FOUND`. `lib.mjs` therefore tries a plain import first (for anyone who does have it installed locally) and otherwise finds the package next to the bin npx exposed. Do not "simplify" that back to a bare import; it will only work on the machine you test it on.

On a fresh machine the first run also downloads Chromium (into `~/.cache/ms-playwright`, a few hundred MB). If a driver dies with "Executable doesn't exist", that download has not happened: `npx --yes --package playwright@1.63.0 playwright install chromium`.

Each script exits non-zero if any check fails, and prints one `PASS`/`FAIL` line per check. Screenshots land in `e2e/screenshots/` (git-ignored).

## If a run looks broken, check for an orphaned Worker first

An interrupted server can leave `workerd` child processes behind when it is killed abruptly, and they are the most likely reason a driver misbehaves in a way that has nothing to do with the code:

- One still holding `:8787` makes the next `pnpm live` die on bind — so the drivers talk to the **old** Worker, quite possibly serving a **stale build**.
- One still holding an open handle on `apps/app/.void` keeps the **old database** alive after that directory has been renamed or deleted. A rename does not close a file handle: the process keeps writing to the inode, so a run that looks like it is exercising a fresh database is not. This cost a reviewer real time.

Check and clear before blaming a driver:

```bash
lsof -i :8787                 # or: ss -lptn 'sport = :8787'
pgrep -af workerd
kill <the PIDs from this checkout>
```

Then confirm the port is actually free (`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/api/health` prints `000`) before starting `pnpm live` again. If you are resetting the database, stop every one of those processes **first**, then remove `apps/app/.void`.

## What they check

- **`library.mjs`** — the Library panel. That changing a filter really refetches (the `?engine=` request is captured off the network, not inferred) and really narrows the grid; that a browser-side filter never invents a query parameter the route would ignore; that a refused filter shows the route's own 400 message and **no** clips rather than silently falling back to the whole library; that a clip whose annotation FAILED is marked differently from one still PENDING; and that its thumbnails stay paused.
- **`editor.mjs`** — the Tracks and Track editor panels. That creating a track opens its editor without leaving `/`; that opening a track loads that track's items (not empty, not another track's); that the end-of-list no-ops are visible as disabled buttons; that a reorder made in the UI survives a full reload of the stage and matches what the API reads back from D1; and that the §14.2 commercial refusal reaches the screen naming the offending clip, with nothing stored.
- **`playback.mjs`** — the stage with the decision layer refused for the whole run. That Go is disabled with nothing staged and says why; that loading a track stages its first item and names it; and — the property that has diverged from the reducer twice in this project — that while a fade runs, Go, Back, transition changes and loading a track are refused **and the refusal is visible**, with Go now deliberately still enabled. Then that the playlist marks where the show is with its section labels, and that auto-advance brings the next item in on its `bars` with nobody pressing anything (§7). It also captures the crossfade.
- **`live.mjs`** — choosing. That three candidates render with their provenance; that a track's own next item is the initial Next, with nothing armed; that clicking a card outlines it with a countdown and it fires with no Go; that choosing again moves the outline and the first choice never plays; that a pick takes the track's next item's place; that `1`/`2`/`3` each outline their card; that `Shift+Space` goes at once, timed against the bar; that a card clicked during a **real** fade is held and fires after the landing, with the fade's target untouched; that `C` opens the chat, that typing there suspends the shortcuts, that a message becomes the standing direction, labelled `dictionary`, without moving the show, and that Clear removes it; that a failed `/api/candidates` request marks the last candidates stale while playback keeps going (§0 principle 2); that `Esc` closes a panel before it means Freeze; and the transport: `H` holds, `B` blacks out, `Esc` freezes (two screenshots of the picture 700ms apart are identical, and differ again once lifted), and Back returns to the previous clip.
- **`stills.mjs`** — the New clip panel end to end: probe, record, save, beside the live picture. That the recording yields three JPEG frames, that each leaves the browser inside TypeSafe's image limits (the 320x180 canvas is below the 280-pixel side minimum, so a frame that was not resized would be refused), and that the clip saves and the upload is accepted. It registers one clip titled `e2e stills` per run, and it writes the frames it captured to `e2e/screenshots/still-N.jpg` so a person can look at them: that they are upright and not black is not something the script can judge.
- **`stage.mjs`** — what only the one screen has. That old bookmarks land on `/`; that the picture fills the viewport with no overlay or panel up by default; that the source link is on screen and clickable; that a candidate's thumbnail, a real `MediaRecorder` WebM uploaded by the driver, shows a decoded first frame while paused, and plays only on hover or focus; that the cards button hides them while the armed clip stays named; that the picture keeps moving behind an open panel and panic is one click away; that the credit and code overlays name the clip on screen; that a reload asks first and brings back the clip, the tempo and a blackout; that a probe is refused while a switch is armed, and that a probe with no WebGL and a recording whose context is lost end in the panel with the picture still moving; that fullscreen enters and leaves; and that a lost live context is said out loud. It writes `30-` to `39-stage-*.png`, including the row and overlays over a white clip and a black clip, which a person has to read.

`seed.mjs` creates everything they need and is idempotent; each script calls it. Every fixture is named with an `e2e ` prefix, and the assertions are scoped to those names rather than to totals, so a library with other clips in it does not break them. Run it alone to just set the fixtures up:

```bash
node apps/app/e2e/seed.mjs
```

It writes `annotation_status` / `reviewed` / `energy` / `tags` straight into the local D1 file with `pnpm exec void db execute` from `apps/app`, because those columns are server-owned (there is no API for them, by design) and annotation cannot run in local mode at all — no AI binding, no queue (§15.3). Those two annotated states are exactly what the library grid has to tell apart, so they have to come from somewhere.

There is no DELETE route for tracks, so each `editor.mjs` / `playback.mjs` run leaves a track behind in the local database. That is why their titles carry a timestamp. A local dev D1 is scratch; `rm -rf apps/app/.void/v3` resets it, after which `pnpm live` re-applies migrations.

## What they do NOT prove

- **SwiftShader is not a GPU.** Chromium launches with `--use-gl=swiftshader`, a software rasteriser. The clips render and the compositor blends them, so the render paths execute — but nothing here says anything about frame rate, or about how any of it behaves on a real projector. §15.2's performance questions are untouched.
- **What the picture shows is not asserted on, beyond whether it moves.** `gl.readPixels` against the canvas returns all zeros: Hydra runs with `preserveDrawingBuffer: false`, so a read from a separate task, between animation frames, gets an empty buffer even while the canvas visibly renders — the same behaviour already documented in `client/register-clip.ts`'s `captureThumbnail`. The page screenshots composite correctly and are the evidence, but they are evidence **a human has to look at**. A driver can compare two of them, and `playback.mjs` says so when it finishes.
- **A choice landing inside the two frames before a bar is not driven here.** The timing is not repeatable in a browser. The slip is proven by the reducer and control tests, and that a load and an immediate cut flash black was measured once in a real browser (ADR 0012).
- **`Esc` under real fullscreen.** Synthetic keys reach the page without the browser's fullscreen UI in the way, so Keyboard Lock is not exercised (§17).
- **Local mode has no Cloudflare Access** (§15.3), so nothing here exercises the Access guard or the policy on `/`. That is unit-tested only.
