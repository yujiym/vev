// SPDX-License-Identifier: AGPL-3.0-or-later
// Drives choosing on the stage. What is under test is the part `vp build` cannot see: that candidates
// arrive and render with their provenance, that clicking one or pressing 1/2/3 outlines it and
// switches on the next bar with nothing else pressed, that choosing again replaces the choice, that a
// click during a real fade is held and fires after the landing, that Shift+Space goes now, that the
// steering chat changes the standing direction without moving the show, and that a failed candidate
// request leaves the last candidates on screen (marked stale) while playback keeps going (§0).
//
// See ./README.md to run it.
import {
  check,
  done,
  flat,
  nextTitle,
  nowTitle,
  openBrowser,
  openPanel,
  openStage,
  panel,
  pictureFrame,
  rowButton,
  seedClips,
  seedTrack,
  shot,
  showNow,
  until,
} from './lib.mjs'

const clips = await seedClips()
const track = await seedTrack(clips)
const { browser, page, pageErrors } = await openBrowser()

await openStage(page)
await showNow(page)

const card = (index) => page.locator('.card').nth(index)
const candidateTitles = async () => await page.locator('.candidate-title').allTextContents()
const decision = async () => flat((await page.locator('.decision').textContent()) ?? '')
const landedOn = async (title, timeout = 20_000) =>
  await until(page, (want) => document.querySelector('.now-title')?.textContent?.includes(want), {
    arg: title,
    timeout,
  })
const threeCards = async () =>
  await until(page, () => document.querySelectorAll('.card').length === 3, { timeout: 20_000 })

// --- candidates render as soon as the first clip lands ---
check('three candidates render on the stage', await threeCards(), `${(await candidateTitles()).length} cards`)
check(
  'each candidate names its clip and engine',
  (await page.locator('.card .meta').count()) === 3,
  (await candidateTitles()).join(' | '),
)
await card(0).hover()
check('its provenance shows on hover', await page.locator('.card .provenance').first().isVisible())
await page.mouse.move(640, 400)
check('the decision indicator says which layer answered', (await decision()).length > 0, await decision())
await shot(page, '20-stage-candidates')

// --- loading a track makes its next item the initial Next, with no switch armed ---
await openPanel(page, 'Playlist')
await panel(page).locator('#track-select').selectOption({ label: track.title })
await panel(page).getByRole('button', { exact: true, name: 'Load' }).click()
await page.waitForSelector(`.next-title:has-text("e2e bright kaleid")`, { timeout: 10_000 })
check(
  'the track’s next item is the initial Next, with candidates as alternatives',
  (await nextTitle(page)).includes('e2e bright kaleid'),
  await nextTitle(page),
)
check('and nothing has armed itself', (await page.locator('.card.chosen').count()) === 0)
await rowButton(page, 'Playlist').click()
await threeCards()

// --- clicking a card outlines it and fires on the next bar, with nothing else pressed ---
const offered = await candidateTitles()
const beforePick = await nowTitle(page)
const firstPick = offered.find((title) => title !== 'e2e bright kaleid')
const secondPick = offered.find((title) => title !== 'e2e bright kaleid' && title !== firstPick)
await card(offered.indexOf(firstPick)).click()
check(
  'clicking a card outlines it and shows how long is left',
  /in \d+\.\d+s/u.test(flat((await page.locator('.card.chosen .eta').textContent()) ?? '')),
  flat((await page.locator('.card.chosen').textContent()) ?? ''),
)
check('Next now names it', (await nextTitle(page)) === firstPick, await nextTitle(page))
check(
  'and the notice under the row says the same',
  (await page.locator('.notices').textContent()).includes(`Next: ${firstPick}`),
)
await shot(page, '21-stage-chosen')

// --- choosing another before the bar replaces it ---
await card(offered.indexOf(secondPick)).click()
check('choosing again moves the outline', (await page.locator('.card.chosen').count()) === 1)
check(
  'to the new choice',
  flat((await page.locator('.card.chosen .candidate-title').textContent()) ?? '') === secondPick,
)
check('the first choice is gone from Next', (await nextTitle(page)) === secondPick, await nextTitle(page))

const fired = await landedOn(secondPick)
check('the switch fired on the bar with no Go', fired, `${beforePick} → ${await nowTitle(page)}`)
check(
  'a fresh answer arrives for the clip that landed',
  await threeCards(),
  (await candidateTitles()).join(' | '),
)

// --- the track carries on after a pick took its next item's place ---
check(
  'the chosen clip took the place of the track’s next item, and the track resumes after it',
  await until(page, () => document.querySelector('.next-title')?.textContent?.includes('e2e dark drift'), {
    timeout: 10_000,
  }),
  await nextTitle(page),
)
await openPanel(page, 'Playlist')
await panel(page).getByRole('button', { exact: true, name: 'Leave' }).click()
await rowButton(page, 'Playlist').click()
await until(page, () => !document.body.textContent.includes('Fade in progress'), { timeout: 20_000 })
await threeCards()

// --- 1/2/3 arm the card they name, and Shift+Space goes now ---
// Early in a bar, so "went at once" and "waited for the bar" cannot be mistaken for each other.
const earlyInBar = async () =>
  await until(
    page,
    () => Number.parseInt(document.querySelector('.phase div')?.style.width ?? '100', 10) < 25,
    {
      timeout: 5000,
    },
  )
await until(page, () => !document.querySelector('.card.chosen'), { timeout: 20_000 })
await page.mouse.click(640, 400)
check('the bar has just begun', await earlyInBar())
const keyed = await candidateTitles()
const chosenTitle = async () =>
  flat((await page.locator('.card.chosen .candidate-title').textContent()) ?? '')
await page.keyboard.press('2')
check('the 2 key outlines the second card', (await chosenTitle()) === keyed[1], await chosenTitle())
await page.keyboard.press('3')
check('the 3 key moves it to the third', (await chosenTitle()) === keyed[2], await chosenTitle())
await page.keyboard.press('1')
check('the 1 key moves it to the first', (await chosenTitle()) === keyed[0], await chosenTitle())

const beforeGoNow = await nowTitle(page)
const pressedAt = Date.now()
await page.keyboard.press('Shift+Space')
const wentAtOnce = await until(
  page,
  (title) =>
    document.body.textContent.includes('Fade in progress') ||
    document.querySelector('.now-title')?.textContent?.includes(title),
  { arg: keyed[0], timeout: 3000 },
)
const goNowMs = Date.now() - pressedAt
check(
  'Shift+Space switches at once rather than waiting for the bar',
  wentAtOnce && goNowMs < 1200,
  `${beforeGoNow} → ${keyed[0]} began ${goNowMs}ms after the press, in a 2000ms bar`,
)
await landedOn(keyed[0])
await until(page, () => !document.body.textContent.includes('Fade in progress'), { timeout: 20_000 })
await threeCards()

// --- a card clicked during a real fade is held, and fires after the landing ---
const fadeOffered = await candidateTitles()
const [fadeTarget, heldTitle] = fadeOffered
await card(0).click()
const transition = page.locator('.row button.transition')
for (let tries = 0; tries < 4 && !(await transition.textContent()).includes('4 bars'); tries += 1) {
  await transition.click()
}
check('the armed switch is set to a long fade', (await transition.textContent()).includes('4 bars'))
const fadeStarted = await until(page, () => document.body.textContent.includes('Fade in progress'), {
  timeout: 15_000,
})
check('a real crossfade is running', fadeStarted, await transition.textContent())
await page.locator('.card', { hasText: heldTitle }).click()
await shot(page, '25-stage-held-during-fade')
check(
  'a click during the fade is held, not lost',
  flat((await page.locator('.card.chosen').textContent()) ?? '').includes('after the fade'),
  flat((await page.locator('.card.chosen').textContent()) ?? ''),
)
check('the fade’s own target has not changed', (await nextTitle(page)) === fadeTarget, await nextTitle(page))
check(
  'and nothing is refused about it: no card is disabled during the fade',
  (await page.locator('.card:disabled').count()) === 0,
)
const heldLanded = await landedOn(heldTitle, 40_000)
check('and it fires after the landing', heldLanded, `${fadeTarget} → ${await nowTitle(page)}`)
await until(page, () => !document.body.textContent.includes('Fade in progress'), { timeout: 40_000 })
await threeCards()

// --- the steering chat changes the shown direction and never moves the show ---
const beforeChat = await nowTitle(page)
await page.keyboard.press('c')
await panel(page).locator('textarea').waitFor({ timeout: 5000 })
check(
  'C opens the chat with the cursor in it',
  await panel(page)
    .locator('textarea')
    .evaluate((el) => el === document.activeElement),
)
await page.keyboard.type('h3 bb')
check(
  'typing in a panel suspends the single-key shortcuts',
  (await panel(page).locator('textarea').inputValue()) === 'h3 bb' &&
    (await page.locator('.blackout').count()) === 0 &&
    !(await rowButton(page, 'Hold').getAttribute('aria-pressed')).includes('true'),
)
await panel(page).locator('textarea').fill('darker')
await panel(page).locator('button[type="submit"]').click()
check(
  'a chat message becomes the standing direction',
  await until(page, () => document.querySelector('.direction-text')?.textContent?.includes('darker'), {
    timeout: 10_000,
  }),
)
check(
  'and the screen says it was interpreted by the dictionary',
  (await panel(page).locator('.provenance').textContent()) === 'dictionary',
  flat(await panel(page).locator('.direction').textContent()),
)
check('steering did not move the show', (await nowTitle(page)) === beforeChat, await nowTitle(page))

await panel(page).getByRole('button', { exact: true, name: 'Clear' }).click()
check(
  'Clear removes the standing direction',
  (await panel(page).locator('.direction-text').count()) === 0,
  flat(await panel(page).locator('.direction').textContent()),
)

// --- a failed candidate request keeps the last candidates and keeps playing ---
let refused = 0
await page.route('**/api/candidates', async (route) => {
  refused += 1
  await route.fulfill({ body: 'offline', contentType: 'text/plain', status: 404 })
})
await panel(page).locator('textarea').fill('faster')
await panel(page).locator('button[type="submit"]').click()
const stale = await until(page, () => document.querySelector('.decision')?.textContent?.includes('stale'), {
  timeout: 10_000,
})
check('a failed candidates request is shown as stale rather than as an empty screen', stale, await decision())
check(
  'the last candidates stay on screen while stale',
  (await page.locator('.card').count()) === 3,
  `${(await candidateTitles()).length} cards`,
)
await shot(page, '23-stage-stale')

// --- Esc closes the panel before it means Freeze ---
await page.keyboard.press('Escape')
check('Esc closes the open panel', (await panel(page).count()) === 0)
check(
  'and has not frozen anything',
  (await rowButton(page, 'Freeze').getAttribute('aria-pressed')) === 'false',
)

const playingBefore = await nowTitle(page)
const pickTitle = (await candidateTitles()).find((title) => title !== playingBefore)
await page.locator('.card', { hasText: pickTitle }).click()
check(
  'playback keeps going after the decision layer failed',
  await landedOn(pickTitle, 30_000),
  `${playingBefore} → ${await nowTitle(page)}`,
)
await until(page, () => !document.body.textContent.includes('Fade in progress'), { timeout: 30_000 })

// --- transport: Hold, Back and the panic row ---
await page.mouse.click(640, 400)
await page.keyboard.press('h')
check(
  'H holds, and the screen says auto-advance is paused',
  await until(page, () => document.querySelector('.notices')?.textContent?.includes('Hold is on')),
)
await page.keyboard.press('h')
check(
  'H again releases it',
  await until(page, () => !document.querySelector('.notices')?.textContent?.includes('Hold is on')),
)

await page.keyboard.press('b')
check('B blacks out the picture', await until(page, () => document.querySelector('.blackout') !== null))
await shot(page, '24-stage-blackout')
check('the row stays usable during a blackout', await rowButton(page, 'Blackout').isVisible())
await page.keyboard.press('b')
check('B again lifts it', await until(page, () => document.querySelector('.blackout') === null))

await page.keyboard.press('Escape')
check(
  'Esc with no panel open freezes, and the button says so',
  (await rowButton(page, 'Freeze').getAttribute('aria-pressed')) === 'true',
)
await page.waitForTimeout(150)
const frozenA = await pictureFrame(page)
await page.waitForTimeout(700)
const frozenB = await pictureFrame(page)
check('a frozen picture holds one frame', frozenA === frozenB)
await page.keyboard.press('Escape')
await page.waitForTimeout(300)
const runningA = await pictureFrame(page)
await page.waitForTimeout(700)
const runningB = await pictureFrame(page)
check('lifting the freeze resumes rendering', runningA !== runningB)

const beforeBack = await nowTitle(page)
await rowButton(page, 'Back').click()
check(
  'Back returns to the previous clip',
  await until(page, (title) => !document.querySelector('.now-title')?.textContent?.includes(title), {
    arg: beforeBack,
  }),
  `${beforeBack} → ${await nowTitle(page)}`,
)

check(
  'no uncaught page errors beyond the 404s this driver injected',
  pageErrors.filter((entry) => !entry.includes('404')).length === 0 &&
    pageErrors.filter((entry) => entry.includes('404')).length <= refused,
  pageErrors.join(' | '),
)
await done(browser)
