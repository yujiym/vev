<!-- SPDX-License-Identifier: AGPL-3.0-or-later -->

# Browser drivers (manual)

Three scripts that open the M2 screens in a real Chromium and assert on what is rendered. They exist because `.svelte` sits outside the type and lint gate (ADR 0001) and `vp build` proves only that a template parses and its imports resolve — it says nothing about whether a handler is wired to the right thing, or whether an `$effect` fires. Running these found two defects no unit test had.

**They are not part of `pnpm test` and not wired into CI, deliberately.** They need a running server and a browser download; making the gate depend on either would trade a fast check for a flaky one.

## Running them

Start the app first, in another terminal — the built SPA served by the local Worker, which is one origin for both the pages and the API:

```bash
pnpm live          # builds apps/web, then cf dev --mode development on 127.0.0.1:8787
```

Then, from the repository root:

```bash
npx --yes --package playwright@1.63.0 node apps/web/e2e/library.mjs
npx --yes --package playwright@1.63.0 node apps/web/e2e/editor.mjs
npx --yes --package playwright@1.63.0 node apps/web/e2e/playback.mjs
```

`playwright@1.63.0` is pinned in that invocation on purpose; keep it, `lib.mjs`'s loader comment, and this line in step. **`playwright` is not a dependency of this repository and must not become one.**

`npx --package` puts playwright's _binary_ on `PATH` but sets no `NODE_PATH` — and ESM ignores `NODE_PATH` anyway — so a bare `import 'playwright'` from a file in this repository does **not** resolve under that invocation. Verified, not assumed: it fails with `ERR_MODULE_NOT_FOUND`. `lib.mjs` therefore tries a plain import first (for anyone who does have it installed locally) and otherwise finds the package next to the bin npx exposed. Do not "simplify" that back to a bare import; it will only work on the machine you test it on.

On a fresh machine the first run also downloads Chromium (into `~/.cache/ms-playwright`, a few hundred MB). If a driver dies with "Executable doesn't exist", that download has not happened: `npx --yes --package playwright@1.63.0 playwright install chromium`.

Each script exits non-zero if any check fails, and prints one `PASS`/`FAIL` line per check. Screenshots land in `e2e/screenshots/` (git-ignored).

## If a run looks broken, check for an orphaned Worker first

`wrangler dev` leaves `workerd` child processes behind when it is killed abruptly, and they are the most likely reason a driver misbehaves in a way that has nothing to do with the code:

- One still holding `:8787` makes the next `pnpm live` die on bind — so the drivers talk to the **old** Worker, quite possibly serving a **stale build**.
- One still holding an open handle on `apps/api/.wrangler/state` keeps the **old database** alive after that directory has been renamed or deleted. A rename does not close a file handle: the process keeps writing to the inode, so a run that looks like it is exercising a fresh database is not. This cost a reviewer real time.

Check and clear before blaming a driver:

```bash
lsof -i :8787                 # or: ss -lptn 'sport = :8787'
pgrep -af 'wrangler|workerd'
pkill -f workerd; pkill -f wrangler
```

Then confirm the port is actually free (`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8787/api/health` prints `000`) before starting `pnpm live` again. If you are resetting the database, stop every one of those processes **first**, then remove `apps/api/.wrangler/state`.

## What they check

- **`library.mjs`** — `/studio/clips`. That changing a filter really refetches (the `?engine=` request is captured off the network, not inferred) and really narrows the grid; that a browser-side filter never invents a query parameter the route would ignore; that a refused filter shows the route's own 400 message and **no** clips rather than silently falling back to the whole library; and that a clip whose annotation FAILED is marked differently from one still PENDING — one needs a human, the other needs only time.
- **`editor.mjs`** — `/studio/tracks` and `/studio/tracks/[id]`. That the editor reads `page.params.id` and loads that track's items (not empty, not another track's); that the end-of-list no-ops are visible as disabled buttons; that a reorder made in the UI survives a full page reload and matches what the API reads back from D1; and that the §14.2 commercial refusal reaches the screen naming the offending clip, with nothing stored.
- **`playback.mjs`** — `/studio` with a real `/output` window open beside it. That loading a track stages its first item and names it; and — the property that has diverged from the reducer twice in this project — that while a fade runs, Go, transition changes, queueing and loading a track are refused **and the refusal is visible**, with Go now deliberately still enabled. Then that auto-advance brings the next item in on its `bars` with nobody pressing anything (§7). It also captures the crossfade itself.

`seed.mjs` creates everything they need and is idempotent; each script calls it. Every fixture is named with an `e2e ` prefix, and the assertions are scoped to those names rather than to totals, so a library with other clips in it does not break them. Run it alone to just set the fixtures up:

```bash
node apps/web/e2e/seed.mjs
```

It writes `annotation_status` / `reviewed` / `energy` / `tags` straight into the local D1 file with `pnpm exec cf d1 raw <local-uuid> --local --persist-to .wrangler/state --sql <sql>` from `apps/api`, because those columns are server-owned (there is no API for them, by design) and annotation cannot run in local mode at all — no AI binding, no queue (§15.3). Those two annotated states are exactly what the library grid has to tell apart, so they have to come from somewhere.

There is no DELETE route for tracks, so each `editor.mjs` / `playback.mjs` run leaves a track behind in the local database. That is why their titles carry a timestamp. A local dev D1 is scratch; `rm -rf apps/api/.wrangler/state` resets it, after which `pnpm live` re-applies migrations.

## What they do NOT prove

- **SwiftShader is not a GPU.** Chromium launches with `--use-gl=swiftshader`, a software rasteriser. The clips render and the compositor blends them, so the render paths execute — but nothing here says anything about frame rate, or about how any of it behaves on a real projector. §15.2's performance questions are untouched.
- **The output window's pixels are not asserted on.** `gl.readPixels` against that canvas returns all zeros: Hydra runs with `preserveDrawingBuffer: false`, so a read from a separate task, between animation frames, gets an empty buffer even while the canvas visibly renders — the same behaviour already documented in `src/lib/register-clip.ts`'s `captureThumbnail`. The page screenshots composite correctly and are the evidence, but they are evidence **a human has to look at**. `playback.mjs` cannot fail on them and says so when it finishes.
- **Local mode has no Cloudflare Access** (§15.3), so nothing here exercises the Access guard on the owner routes. That is unit-tested only.
