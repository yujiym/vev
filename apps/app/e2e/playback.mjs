// SPDX-License-Identifier: AGPL-3.0-or-later
// Drives the stage with the decision layer refused for the whole run.
//
// The property this exists for is the one that has diverged from the reducer twice in this project:
// while a fade is running, Go, Back, transition changes and loading a track are refused AND THE
// REFUSAL IS VISIBLE. The reducer half is unit-tested; this is the screen half. It also captures the
// crossfade itself, and proves that auto-advance brings the next track item in with nobody pressing
// anything.
//
// LIMITATION worth reading before trusting the captures: `gl.readPixels` against the live canvas
// returns all zeros — Hydra runs with `preserveDrawingBuffer: false`, so a read from a separate task,
// between animation frames, gets an empty buffer even while the canvas visibly renders. So there is
// no numeric assertion about what the picture shows. The screenshots composite correctly and are the
// evidence, and they are evidence a HUMAN has to look at — this script cannot fail on them.
//
// See ./README.md to run it.
import {
  check,
  done,
  flat,
  nextTitle,
  openBrowser,
  openPanel,
  openStage,
  panel,
  rowButton,
  seedClips,
  seedSingleStepTrack,
  seedTrack,
  shot,
  showNow,
  until,
} from './lib.mjs'

const clips = await seedClips()
const track = await seedTrack(clips)
const { browser, page, pageErrors } = await openBrowser()

// Candidates are refused for the whole run, so nothing is ever staged but what the track stages: the
// "nothing queued" state is then deterministic instead of a race against the first answer, and every
// property below is shown to hold with the decision layer down (§0 principle 2).
let refused = 0
await page.route('**/api/candidates', async (route) => {
  refused += 1
  await route.fulfill({ body: 'offline', contentType: 'text/plain', status: 404 })
})
await openStage(page)
await showNow(page)

const fading = async () => (await page.locator('text=Fade in progress').count()) > 0
const trackStatus = async () => flat((await page.locator('.track-status').textContent()) ?? '')

// --- the screen offers exactly what the reducer would accept, before anything is queued ---
// A panel guarding only on `fading` would offer Go here, with nothing queued, and the press would do
// nothing.
check('Go is disabled with nothing queued', await rowButton(page, 'Go').isDisabled())
check(
  'and it says why rather than leaving a dead button',
  (await rowButton(page, 'Go').getAttribute('title'))?.includes('Nothing is staged') === true,
  await rowButton(page, 'Go').getAttribute('title'),
)
check(
  'a failed candidates request is on screen, and the picture keeps its place',
  await until(page, () => document.querySelector('.stage')?.textContent?.includes('stale')),
)

// --- load a saved track ---
await openPanel(page, 'Playlist')
await panel(page).locator('#track-select').selectOption({ label: track.title })
await panel(page).getByRole('button', { exact: true, name: 'Load' }).click()
await page.waitForSelector(`.next-title:has-text("${clips.get('e2e bright kaleid').title}")`, {
  timeout: 10_000,
})
check(
  'loading a track stages item 1 and names it as Next',
  (await nextTitle(page)).includes('e2e bright kaleid') && (await trackStatus()).includes('item 1 of 2'),
  await trackStatus(),
)
await shot(page, '07-stage-track-loaded')

// --- Go, then catch the crossfade while it runs ---
await rowButton(page, 'Go').click()
const deadline = Date.now() + 8000
while (!(await fading()) && Date.now() < deadline) {
  await page.waitForTimeout(60)
}
check('the crossfade is on screen as "Fade in progress"', await fading())
await shot(page, '12-stage-fade-early')

check(
  'the status line stops telling the performer to press Go once they have',
  !(await trackStatus()).includes('Press Go to start') && (await trackStatus()).includes('on its way in'),
  await trackStatus(),
)

const titleOf = async (name) => (await rowButton(page, name).getAttribute('title')) ?? ''
check(
  'each control the reducer refuses says so in its tooltip',
  (await titleOf('Go')).includes('Fade in progress') && (await titleOf('Back')).includes('Fade in progress'),
  `${await titleOf('Go')} / ${await titleOf('Back')}`,
)
check('Go is disabled mid-fade', await rowButton(page, 'Go').isDisabled())
const transitionButton = page.locator('.row button.transition')
check('the transition is disabled mid-fade', await transitionButton.isDisabled())
check(
  'and says why',
  ((await transitionButton.getAttribute('title')) ?? '').includes('Fade in progress'),
  await transitionButton.getAttribute('title'),
)
check('Back is disabled mid-fade', await rowButton(page, 'Back').isDisabled())
check(
  'the track selector and Load are disabled mid-fade, and the panel says why',
  (await panel(page).locator('#track-select').isDisabled()) &&
    (await panel(page).getByRole('button', { exact: true, name: 'Load' }).isDisabled()) &&
    (await panel(page).textContent()).includes('Fade in progress'),
)
// Deliberately NOT disabled: the reducer does not refuse Go now mid-fade, it finishes the fade.
check('Go now stays available', !(await rowButton(page, 'Go now').isDisabled()))
await shot(page, '13-stage-fade-mid')

const faded = await until(page, () => !document.body.textContent.includes('Fade in progress'), {
  timeout: 15_000,
})
check('the fade completed within its two bars', faded)
await shot(page, '14-stage-after')
check(
  'once the fade completes the playlist shows item 1 playing with item 2 staged',
  (await trackStatus()).includes('item 1 of 2') && (await trackStatus()).includes('next staged'),
  await trackStatus(),
)
check(
  'and marks where the show is, with its section labels',
  (await panel(page).locator('.timeline li.current .step-title').textContent()) === 'e2e bright kaleid' &&
    (await panel(page).locator('.timeline li.queued .section').textContent()) === 'outro',
  flat(await panel(page).locator('.timeline').textContent()),
)

// --- auto-advance: item 1 holds for its four bars, then item 2 arrives with nobody pressing ---
const advanced = await until(
  page,
  () => document.querySelector('.track-status')?.textContent?.includes('item 2 of 2'),
  {
    timeout: 30_000,
  },
)
check('auto-advance brought item 2 in with no further press (§7)', advanced, await trackStatus())
check('and the track then reads as ended rather than looping', (await trackStatus()).includes('end of track'))
await shot(page, '10-stage-auto-advanced')

// --- a clip whose shader will not compile costs its own switch ---
// Hydra's `.out()` swallows the GLSL error, so `load` returns normally. The picture would switch onto
// a blank buffer, or onto whichever clip last held the slot, unless the load itself reports it.
// The clip is a real one whose code this page is told is something else, so nothing that cannot
// compile is ever stored for a later run's candidates to offer.
const victim = clips.get('e2e pending annotation')
const broken = await seedSingleStepTrack(victim)
await page.route(`**/api/clips/${victim.id}`, async (route) => {
  const response = await route.fetch()
  await route.fulfill({
    json: { ...(await response.json()), code: 'solid("undefined_identifier", 0, 0, 1).out()' },
    response,
  })
})
const keptTitle = flat((await page.locator('.now-title').textContent()) ?? '')
// Closing and reopening the panel is what makes it fetch the track list again.
await rowButton(page, 'Playlist').click()
await openPanel(page, 'Playlist')
await panel(page).locator('#track-select').selectOption({ label: broken.title })
await panel(page).getByRole('button', { exact: true, name: 'Load' }).click()
check(
  'a clip that did not compile says so on screen',
  await until(page, () => document.querySelector('.notices .bad')?.textContent?.includes('did not load')),
  flat(
    (await page
      .locator('.notices')
      .textContent()
      .catch(() => '')) ?? '',
  ),
)
await page.waitForTimeout(1500)
check('and is not staged as Next, so Go has nothing to fire', await rowButton(page, 'Go').isDisabled())
check(
  'and the picture keeps the clip it had',
  flat((await page.locator('.now-title').textContent()) ?? '') === keptTitle,
  flat((await page.locator('.now-title').textContent()) ?? ''),
)

const refusedLoads = pageErrors.filter((entry) => entry.includes('did not load'))
check(
  'no uncaught page errors beyond the 404s this driver injected and the one refusal it asked for',
  refusedLoads.length === 1 &&
    pageErrors.every((entry) => entry.includes('404') || refusedLoads.includes(entry)) &&
    pageErrors.length <= refused + 1,
  pageErrors.join(' | '),
)
console.log('\nNOTE: 12/13/14-stage-*.png show the crossfade. Nothing here asserts on them — look at them.')
await done(browser)
