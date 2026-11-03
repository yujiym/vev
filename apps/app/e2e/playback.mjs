// SPDX-License-Identifier: AGPL-3.0-or-later
// Drives /studio with a real /output window open beside it, as two pages in ONE browser context —
// so they share an origin, and therefore the BroadcastChannel the panel publishes on. That is the
// real two-window arrangement, not a simulation of it.
//
// The property this exists for is the one that has diverged from the reducer twice in this
// project: while a fade is running, Go, Back, transition changes and loading a track are refused
// AND THE REFUSAL IS VISIBLE. The reducer half is unit-tested; this is the screen half. It also
// captures the crossfade itself, and proves that auto-advance brings the next track item in with
// nobody pressing anything.
//
// LIMITATION worth reading before trusting the captures: `gl.readPixels` against the output canvas
// returns all zeros — Hydra runs with `preserveDrawingBuffer: false`, so a read from a separate
// task, between animation frames, gets an empty buffer even while the canvas visibly renders (the
// same behaviour documented in `src/lib/register-clip.ts`'s `captureThumbnail`). So there is no
// numeric assertion about what the output shows. The page screenshots composite correctly and are
// the evidence, and they are evidence a HUMAN has to look at — this script cannot fail on them.
//
// See ./README.md to run it.
import { BASE, check, done, flat, openBrowser, seedClips, seedTrack, shot, until } from './lib.mjs'

const clips = await seedClips()
const track = await seedTrack(clips)
const { browser, context, page, pageErrors } = await openBrowser()

// Candidates are refused for the whole run, so nothing is ever staged but what the track stages:
// the "nothing queued" state is then deterministic instead of a race against the first answer, and
// every property below is shown to hold with the decision layer down (§0 principle 2).
let refused = 0
await page.route('**/api/candidates', async (route) => {
  refused += 1
  await route.fulfill({ body: 'offline', contentType: 'text/plain', status: 404 })
})
await page.goto(`${BASE}/studio`, { waitUntil: 'networkidle' })
const output = await context.newPage()
await output.goto(`${BASE}/output`, { waitUntil: 'networkidle' })
await page.bringToFront()

const panel = async () => await page.textContent('main')
const fading = async () => (await page.locator('text=Fade in progress').count()) > 0
const nextTitle = async () => flat((await page.locator('.next .clip-title').textContent()) ?? '')

// --- the screen offers exactly what the reducer would accept, before anything is queued ---
// This is finding 5 seen from the outside: a panel guarding only on `fading` would offer Go here,
// with nothing queued, and the press would do nothing.
check('Go is disabled with nothing queued', await page.locator('.next button:text-is("Go")').isDisabled())
check(
  'and the screen says why rather than leaving a dead button',
  (await panel()).includes('Nothing is queued'),
  flat(await page.locator('.next').textContent()),
)

// --- load a saved track ---
await page.selectOption('#track-select', { label: track.title })
await page.click('button:has-text("Load")')
await page.waitForSelector(`.next .clip-title:has-text("${clips.get('e2e bright kaleid').title}")`, {
  timeout: 10_000,
})
check(
  'loading a track stages item 1 and names it as Next',
  (await nextTitle()).includes('e2e bright kaleid') && (await panel()).includes('item 1 of 2'),
  flat(await page.locator('.next').textContent()),
)
await shot(page, '07-panel-track-loaded')
await shot(output, '11-output-before')

// --- Go, then catch the crossfade while it runs ---
await page.click('.next button:text-is("Go")')
const deadline = Date.now() + 8000
while (!(await fading()) && Date.now() < deadline) {
  await page.waitForTimeout(60)
}
check('the crossfade is visible in the panel as "Fade in progress"', await fading())
await shot(output, '12-output-fade-early')

check(
  'the status line stops telling the performer to press Go once they have',
  !(await panel()).includes('Press Go to start') && (await panel()).includes('on its way in'),
  flat(await page.locator('.track-status').textContent()),
)

const notices = await page.locator('[role="status"]:has-text("Fade in progress")').allTextContents()
check(
  'every control the reducer refuses says so, in its own place',
  notices.length === 4,
  `${notices.length} notices: ${notices.map((notice) => flat(notice).slice(0, 40)).join(' | ')}`,
)
check('Go is disabled mid-fade', await page.locator('.next button:text-is("Go")').isDisabled())
check('Change is disabled mid-fade', await page.locator('.next button:text-is("Change")').isDisabled())
check('Back is disabled mid-fade', await page.locator('.now button:text-is("Back")').isDisabled())
check(
  'the track selector and Load are disabled mid-fade',
  (await page.locator('#track-select').isDisabled()) &&
    (await page.locator('button:has-text("Load")').isDisabled()),
)
// Deliberately NOT disabled: the reducer does not refuse Go now mid-fade, it finishes the fade.
check('Go now stays available', !(await page.locator('.next button:text-is("Go now")').isDisabled()))
await shot(page, '08-panel-fade-refusals')
await shot(output, '13-output-fade-mid')

const faded = await until(page, () => !document.body.textContent.includes('Fade in progress'), {
  timeout: 15_000,
})
check('the fade completed within its two bars', faded)
await shot(output, '14-output-after')
check(
  'once the fade completes the panel shows item 1 playing with item 2 staged',
  (await panel()).includes('item 1 of 2') && (await panel()).includes('next staged'),
  flat(await page.locator('.track-status').textContent()),
)

// --- auto-advance: item 1 holds for its four bars, then item 2 arrives with nobody pressing ---
const advanced = await until(page, () => document.body.textContent.includes('item 2 of 2'), {
  timeout: 30_000,
})
check(
  'auto-advance brought item 2 in with no further press (§7)',
  advanced,
  flat(await page.locator('.timeline').textContent()).slice(0, 160),
)
check('and the track then reads as ended rather than looping', (await panel()).includes('end of track'))
await shot(page, '10-panel-auto-advanced')

check(
  'no uncaught page errors in the panel beyond the 404s this driver injected',
  pageErrors.every((entry) => entry.includes('404')) && pageErrors.length <= refused,
  pageErrors.join(' | '),
)
console.log(
  '\nNOTE: 11/12/13/14-output-*.png show the crossfade. Nothing here asserts on them — look at them.',
)
await done(browser)
