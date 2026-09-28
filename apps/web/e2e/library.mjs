// SPDX-License-Identifier: AGPL-3.0-or-later
// Drives /studio/clips. What is under test is everything `vp build` cannot see: whether the
// `$effect` on a filter change actually refetches, whether a browser-side filter stays out of the
// query string, whether a refused filter is SHOWN rather than swallowed, and whether a clip whose
// annotation failed looks different from one still pending.
//
// Assertions are scoped to the `e2e ` fixtures, never to totals: a library with other clips in it
// must not break this. See ./README.md to run it.
import { BASE, check, done, flat, openBrowser, seedClips, shot, until } from './lib.mjs'

await seedClips()
const { apiCalls, browser, page, pageErrors } = await openBrowser()

await page.goto(`${BASE}/studio/clips`, { waitUntil: 'networkidle' })
const cards = page.locator('ul.grid > li')
await cards.first().waitFor({ timeout: 10_000 })

/** Runs IN the page. Reads the first `.meta` per card (the second holds tags) and refuses an empty grid, since `[].every()` is vacuously true mid-refetch. */
const allCardsMatch = (want) => {
  const shown = [...document.querySelectorAll('ul.grid > li')]
  return shown.length > 0 && shown.every((li) => li.querySelector('.meta')?.textContent.includes(want))
}
const manyCards = () => document.querySelectorAll('ul.grid > li').length > 1

const cardFor = (title) => cards.filter({ has: page.locator('h2', { hasText: title }) })
const flagsOf = async (title) => await cardFor(title).locator('.flag').allTextContents()
const visible = async () => await cards.locator('h2').allTextContents()

check('the first fetch carries no filter parameters', apiCalls.includes('/api/clips'), apiCalls.join(' '))
// Named "every", so it checks every one — it used to assert a single card and claim the set.
const SEEDED = [
  'e2e dark drift',
  'e2e bright kaleid',
  'e2e pending annotation',
  'e2e annotated and reviewed',
  'e2e failed annotation',
  'e2e unknown licence',
  'e2e textmode only',
]
const onScreen = await visible()
const missing = SEEDED.filter((title) => !onScreen.some((shown) => shown.includes(title)))
check('every seeded clip is on screen', missing.length === 0, `missing: ${missing.join(', ') || 'none'}`)

check(
  'a FAILED annotation is flagged as needing attention',
  (await flagsOf('e2e failed annotation')).includes('Annotation failed') &&
    (await cardFor('e2e failed annotation').locator('.flag.attention').count()) > 0,
  (await flagsOf('e2e failed annotation')).join(' / '),
)
check(
  'a PENDING annotation is flagged differently, as waiting',
  (await flagsOf('e2e pending annotation')).includes('Not yet annotated') &&
    (await cardFor('e2e pending annotation').locator('.flag.waiting').count()) > 0,
  (await flagsOf('e2e pending annotation')).join(' / '),
)
check(
  'an unknown licence is flagged (§14.2)',
  (await flagsOf('e2e unknown licence')).includes('Licence unknown'),
  (await flagsOf('e2e unknown licence')).join(' / '),
)
check('an unreviewed clip is marked (§11)', (await flagsOf('e2e pending annotation')).includes('Unreviewed'))
check(
  'a reviewed, annotated, licensed clip carries no flag at all',
  (await flagsOf('e2e annotated and reviewed')).length === 0,
  (await flagsOf('e2e annotated and reviewed')).join(' / '),
)
await shot(page, '01-library-all-clips')

// --- the $effect on a filter change: does it refetch, and does the grid narrow? ---
apiCalls.length = 0
await page.selectOption('select >> nth=0', 'textmode')
// A card renders up to two `.meta` lines (engine/licence/energy, then tags), so this reads the
// FIRST one per card, not every `.meta` on the page. And `every` over an empty list is vacuously
// true while the refetch is in flight, so a non-empty list is part of the condition.
const narrowedByEngine = await until(page, allCardsMatch, { arg: 'textmode' })
check('the grid settled on the engine filter', narrowedByEngine)
check(
  'changing the engine filter refetches with that filter on the URL',
  apiCalls.includes('/api/clips?engine=textmode'),
  apiCalls.join(' '),
)
check(
  'and every remaining clip really is that engine',
  (await visible()).includes('e2e textmode only') && !(await visible()).includes('e2e dark drift'),
  (await visible()).join(', '),
)
await shot(page, '02-library-engine-filter')

// --- a browser-side filter must NOT invent a query parameter the route would ignore ---
await page.selectOption('select >> nth=0', '')
check('the grid came back when the filter was cleared', await until(page, manyCards))
apiCalls.length = 0
await page.selectOption('select >> nth=1', { label: '3' })
const narrowedByEnergy = await until(page, allCardsMatch, { arg: 'energy 3' })
check('the grid settled on the energy filter', narrowedByEnergy)
check(
  'the energy filter narrows in the browser and never sends ?energy=',
  (await visible()).includes('e2e annotated and reviewed') && apiCalls.every((c) => !c.includes('energy')),
  `visible: ${(await visible()).join(', ')} · calls: ${apiCalls.join(' ')}`,
)
await page.selectOption('select >> nth=1', { label: 'any' })
check('the grid came back when the filter was cleared', await until(page, manyCards))

const errorsBeforeInterception = pageErrors.length

// --- a refused filter value must be SHOWN, not answered with the whole library ---
// The select can only emit valid engine values, so the 400 the route gives a bad one is injected
// with the route's own message body. What that exercises is the SCREEN's error path — the half
// that could silently fall back to showing everything, which reads as success.
await page.route(
  '**/api/clips?engine=*',
  async (route) =>
    await route.fulfill({
      body: 'engine must be one of "hydra", "textmode", "isf"; got "hydraa"',
      contentType: 'text/plain',
      status: 400,
    }),
)
await page.selectOption('select >> nth=0', 'hydra')
await page.waitForSelector('[role="alert"]', { timeout: 10_000 })
const alert = flat(await page.locator('[role="alert"]').textContent())
check('a refused filter shows the route’s own message', alert.includes('engine must be one of'), alert)
check('and shows no clips rather than the whole library', (await cards.count()) === 0)
await shot(page, '03-library-filter-refused')

// Counted before the deliberate 400: the browser logs that response itself, and it is the
// behaviour under test rather than a defect.
check('no uncaught page errors', errorsBeforeInterception === 0, pageErrors.join(' | '))
await done(browser)
