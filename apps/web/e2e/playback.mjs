// SPDX-License-Identifier: AGPL-3.0-or-later
// Drives /studio with a real /output window open beside it, as two pages in ONE browser context —
// so they share an origin, and therefore the BroadcastChannel the panel publishes on. That is the
// real two-window arrangement, not a simulation of it.
//
// The property this exists for is the one that has diverged from the reducer twice in this
// project: while a fade is running, Go, transition changes and queueing are refused AND THE
// REFUSAL IS VISIBLE. The reducer half is unit-tested; this is the panel half. It also captures
// the crossfade itself, out of the dark start fixture into a visibly different clip.
//
// LIMITATION worth reading before trusting the captures: `gl.readPixels` against the output canvas
// returns all zeros — Hydra runs with `preserveDrawingBuffer: false`, so a read from a separate
// task, between animation frames, gets an empty buffer even while the canvas visibly renders (the
// same behaviour documented in `src/lib/register-clip.ts`'s `captureThumbnail`). So there is no
// numeric assertion about what the output shows. The page screenshots composite correctly and are
// the evidence, and they are evidence a HUMAN has to look at — this script cannot fail on them.
//
// See ./README.md to run it.
import { BASE, check, done, flat, openBrowser, seedClips, seedTrack, shot } from './lib.mjs'

const clips = await seedClips()
const track = await seedTrack(clips)
const { browser, context, page, pageErrors } = await openBrowser()

await page.goto(`${BASE}/studio`, { waitUntil: 'networkidle' })
const output = await context.newPage()
await output.goto(`${BASE}/output`, { waitUntil: 'networkidle' })
await page.bringToFront()

const panel = async () => await page.textContent('main')
const fading = async () => (await page.locator('text=Fade in progress').count()) > 0

// --- load a saved track ---
await page.selectOption('select >> nth=0', { label: track.title })
await page.click('button:has-text("Load track")')
await page.waitForSelector('text=Press Go to start the track', { timeout: 10_000 })
check(
  'loading a track stages item 1 and says it needs a Go to start',
  (await panel()).includes('item 1 of 2 is staged'),
)
check(
  'the queued clip is named, not shown as a UUID',
  (await panel()).includes('Next: e2e bright kaleid'),
  flat(await page.locator('main section >> nth=1').textContent()),
)
await shot(page, '07-panel-track-loaded')
await shot(output, '11-output-before')

// --- Go, then catch the crossfade while it runs ---
await page.click('button:has-text("Go")')
const deadline = Date.now() + 8000
while (!(await fading()) && Date.now() < deadline) {
  await page.waitForTimeout(60)
}
check('the crossfade is visible in the panel as "Fade in progress"', await fading())
await shot(output, '12-output-fade-early')

check(
  'the status line stops telling the performer to press Go once they have',
  !(await panel()).includes('Press Go to start') && (await panel()).includes('on its way in'),
  flat(await page.locator('main section').first().textContent()),
)

const notices = await page.locator('[role="status"]:has-text("Fade in progress")').allTextContents()
check(
  'every control the reducer refuses says so, in its own section',
  notices.length === 4,
  `${notices.length} notices: ${notices.map((n) => flat(n).slice(0, 40)).join(' | ')}`,
)
check('Go is disabled', await page.locator('button:has-text("Go")').first().isDisabled())
check(
  'the transition radios are disabled',
  (await page.locator('input[type="radio"][value="cut"]').isDisabled()) &&
    (await page.locator('input[type="radio"][value="crossfade"]').isDisabled()),
)
check(
  'the fixture queue buttons are disabled',
  await page.locator('button:has-text("Quiet — dark")').isDisabled(),
)
check(
  'the track selector and Load track are disabled',
  (await page.locator('select >> nth=0').isDisabled()) &&
    (await page.locator('button:has-text("Load track")').isDisabled()),
)
// Deliberately NOT disabled: the reducer does not refuse Go now mid-fade, it finishes the fade.
check('Go now stays available', !(await page.locator('button:has-text("Go now")').isDisabled()))
await shot(page, '08-panel-fade-refusals')
await shot(output, '13-output-fade-mid')

await page.waitForFunction(() => !document.body.textContent.includes('Fade in progress'), { timeout: 15_000 })
await shot(output, '14-output-after')
check(
  'once the fade completes the panel shows item 1 playing with item 2 staged',
  (await panel()).includes('item 1 of 2') && (await panel()).includes('next staged'),
  flat(await page.locator('main section').first().textContent()),
)

// --- auto-advance: item 1 holds for its four bars, then item 2 arrives with nobody pressing ---
await page.waitForFunction(() => document.body.textContent.includes('item 2 of 2'), { timeout: 30_000 })
check('auto-advance brought item 2 in with no further press (§7)', true)
check('and the track then reads as ended rather than looping', (await panel()).includes('end of track'))
await shot(page, '10-panel-auto-advanced')

check('no uncaught page errors in the panel', pageErrors.length === 0, pageErrors.join(' | '))
console.log(
  '\nNOTE: 11/12/13/14-output-*.png show the crossfade. Nothing here asserts on them — look at them.',
)
await done(browser)
