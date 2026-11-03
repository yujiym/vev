// SPDX-License-Identifier: AGPL-3.0-or-later
// Drives the control screen of spec §12.1 with a real output window beside it. What is under test
// is the part `vp build` cannot see: that candidates arrive and render with their provenance, that
// clicking one replaces Next, that Space actually switches, that the steering chat changes the
// standing direction without moving the show, and that a failed candidate request leaves the last
// candidates on screen (marked stale) while playback keeps going (spec §0 principle 2).
//
// See ./README.md to run it.
import { BASE, check, done, flat, openBrowser, seedClips, seedTrack, shot, until } from './lib.mjs'

const clips = await seedClips()
const track = await seedTrack(clips)
const { browser, context, page, pageErrors } = await openBrowser()

await page.goto(`${BASE}/studio`, { waitUntil: 'networkidle' })
const output = await context.newPage()
await output.goto(`${BASE}/output`, { waitUntil: 'networkidle' })
await page.bringToFront()

const panel = async () => await page.textContent('main')
const nextTitle = async () => flat((await page.locator('.next .clip-title').textContent()) ?? '')
const nowTitle = async () => flat((await page.locator('.now .clip-title').textContent()) ?? '')
const candidateTitles = async () => await page.locator('.candidate-title').allTextContents()
const decision = async () => flat((await page.locator('.decision').textContent()) ?? '')

// --- candidates render as soon as the first clip lands ---
const candidatesReady = await until(page, () => document.querySelectorAll('.candidate').length === 3, {
  timeout: 20_000,
})
check(
  'three candidates render on the control screen',
  candidatesReady,
  `${(await candidateTitles()).length} cards`,
)

const offered = await candidateTitles()
check(
  'each candidate names its clip and its provenance',
  offered.length === 3 && (await page.locator('.candidate .provenance').count()) === 3,
  offered.join(' | '),
)
check('the decision indicator says which layer answered', (await decision()).length > 0, await decision())
await shot(page, '20-control-candidates')

// --- loading a track makes its next item the initial Next ---
await page.selectOption('#track-select', { label: track.title })
await page.click('button:has-text("Load")')
await page.waitForSelector(`.next .clip-title:has-text("${clips.get('e2e bright kaleid').title}")`, {
  timeout: 10_000,
})
check(
  'the track’s next item is the initial Next, with candidates as alternatives',
  (await nextTitle()).includes('e2e bright kaleid'),
  await nextTitle(),
)

// --- a candidate click replaces Next ---
const beforePick = await nextTitle()
const titles = await candidateTitles()
const pickIndex = titles.findIndex((title) => !beforePick.includes(title))
check(
  'a candidate other than the track’s own next is available to pick',
  pickIndex !== -1,
  titles.join(' | '),
)
await page.locator('.candidate').nth(pickIndex).click()
const picked = titles[pickIndex]
check(
  'clicking a candidate replaces Next',
  (await nextTitle()) === picked,
  `${beforePick} → ${await nextTitle()}`,
)
check(
  'and the picked card is marked as the one that will play',
  (await page.locator('.candidate.leading .candidate-title').textContent()) === picked,
)
await shot(page, '21-control-picked')

// --- Space fires the switch ---
await page.locator('.now').click()
const beforeGo = await nowTitle()
await page.keyboard.press('Space')
const switched = await until(
  page,
  (title) => document.querySelector('.now .clip-title')?.textContent?.includes(title),
  { arg: picked, timeout: 20_000 },
)
check('Space fires the switch to the picked candidate', switched, `${beforeGo} → ${await nowTitle()}`)
await shot(output, '22-output-after-switch')

// --- the steering chat changes the shown direction and never moves the show ---
await page.click('.chat-toggle')
await page.fill('textarea', 'darker')
await page.click('button[type="submit"]')
const directionShown = await until(
  page,
  () => document.querySelector('.direction-text')?.textContent?.includes('darker'),
  { timeout: 10_000 },
)
check('a chat message becomes the standing direction', directionShown)
check(
  'and the screen says it was interpreted by the dictionary',
  (await page.locator('.direction .provenance').textContent()) === 'dictionary',
  flat((await page.locator('.direction').textContent()) ?? ''),
)
const stillPlaying = await nowTitle()
check('steering did not move the show', stillPlaying === picked, `${picked} → ${stillPlaying}`)

await page.click('.direction button:has-text("Clear")')
check(
  'Clear removes the standing direction',
  (await page.locator('.direction-text').count()) === 0,
  flat((await page.locator('.direction').textContent()) ?? ''),
)

// --- a failed candidate request keeps the last candidates and keeps playing ---
let refused = 0
await page.route('**/api/candidates', async (route) => {
  refused += 1
  await route.fulfill({ body: 'offline', contentType: 'text/plain', status: 404 })
})
await page.fill('textarea', 'faster')
await page.click('button[type="submit"]')
const stale = await until(page, () => document.querySelector('.decision')?.textContent?.includes('stale'), {
  timeout: 10_000,
})
check('a failed candidates request is shown as stale rather than as an empty screen', stale, await decision())
check(
  'the last candidates stay on screen while stale',
  (await page.locator('.candidate').count()) === 3,
  `${(await candidateTitles()).length} cards`,
)
await shot(page, '23-control-stale')

const fadedBefore = await until(page, () => !document.body.textContent.includes('Fade in progress'), {
  timeout: 15_000,
})
const playingBefore = await nowTitle()
const nextBefore = await nextTitle()
await page.keyboard.press('Space')
const keptPlaying = await until(
  page,
  (title) => document.querySelector('.now .clip-title')?.textContent?.includes(title),
  { arg: nextBefore, timeout: 20_000 },
)
check(
  'playback keeps going after the decision layer failed',
  fadedBefore && keptPlaying,
  `${playingBefore} → ${await nowTitle()}`,
)

// --- transport: Hold, Back and the panic row, on the control screen and on the output ---
await page.locator('.now').click()
await page.keyboard.press('h')
check(
  'H holds, and the screen says auto-advance is paused',
  await until(page, () => document.querySelector('.held')?.textContent?.includes('Hold is on')),
)
await page.keyboard.press('h')
check('H again releases it', await until(page, () => !document.querySelector('.held')))

const frame = async () => (await output.screenshot()).toString('base64')
await page.keyboard.press('b')
check(
  'B blacks out the output window',
  await until(output, () => document.querySelector('.blackout') !== null),
)
await shot(output, '24-output-blackout')
await output.reload({ waitUntil: 'networkidle' })
check(
  'an output window reloaded during a blackout comes back black, not showing the covered picture',
  await until(output, () => document.querySelector('.blackout') !== null),
)
await page.keyboard.press('b')
check('B again lifts it', await until(output, () => document.querySelector('.blackout') === null))

await page.keyboard.press('Escape')
check(
  'Esc freezes, and the control screen says so',
  await until(page, () => document.querySelector('.held')?.textContent?.includes('freeze')),
)
const frozenA = await frame()
await output.waitForTimeout(700)
const frozenB = await frame()
check('a frozen output holds one frame', frozenA === frozenB)
await page.keyboard.press('Escape')
await output.waitForTimeout(300)
const runningA = await frame()
await output.waitForTimeout(700)
const runningB = await frame()
check('lifting the freeze resumes rendering', runningA !== runningB)

const beforeBack = await nowTitle()
await page.click('button:has-text("Back")')
check(
  'Back returns to the previous clip',
  await until(page, (title) => !document.querySelector('.now .clip-title')?.textContent?.includes(title), {
    arg: beforeBack,
  }),
  `${beforeBack} → ${await nowTitle()}`,
)

check(
  'no uncaught page errors in the control screen beyond the 404s this driver injected',
  pageErrors.filter((entry) => !entry.includes('404')).length === 0 &&
    pageErrors.filter((entry) => entry.includes('404')).length <= refused,
  pageErrors.join(' | '),
)
await done(browser)
