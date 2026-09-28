// SPDX-License-Identifier: AGPL-3.0-or-later
// Drives /studio/tracks and /studio/tracks/[id]. What is under test: that the editor reads
// `page.params.id` and loads THAT track's items, that a reorder made in the UI survives a full
// reload (and matches what the API reads back from D1), and that the §14.2 commercial refusal
// reaches the screen naming the clip instead of dying in the network tab.
//
// Seeds its own clips and creates its own track, so it never depends on what an earlier run left
// behind. See ./README.md to run it.
import { BASE, check, done, flat, openBrowser, seedClips, seedTrack, shot } from './lib.mjs'

const clips = await seedClips()
const track = await seedTrack(clips)
const { browser, page, pageErrors } = await openBrowser()

const titles = async () => await page.locator('ol > li strong').allTextContents()
const readBack = async () => await (await fetch(`${BASE}/api/tracks/${track.id}`)).json()

// --- the index page, and the create form that navigates to a new editor ---
await page.goto(`${BASE}/studio/tracks`, { waitUntil: 'networkidle' })
const row = page.locator('main ul li').filter({ hasText: track.title })
await row.first().waitFor({ timeout: 10_000 })
check(
  'the tracks index lists the saved track and its clip count',
  flat(await row.first().textContent()).includes('2 clips'),
  flat(await row.first().textContent()),
)

await page.fill('input[type="text"]', 'e2e created in the browser')
await page.click('button:has-text("Create")')
await page.waitForURL(/\/studio\/tracks\/[0-9a-f-]+$/u, { timeout: 10_000 })
await page.locator('h1').waitFor({ timeout: 10_000 })
const otherId = page.url().split('/').at(-1)
check(
  'creating a track navigates to its own editor',
  (await page.locator('h1').textContent()) === 'e2e created in the browser',
)
check('a brand-new track opens empty', (await page.textContent('main')).includes('no clips yet'))

// --- opening by id loads THAT track's items, resolved to clip titles ---
await page.goto(`${BASE}/studio/tracks/${track.id}`, { waitUntil: 'networkidle' })
await page.locator('ol > li').first().waitFor({ timeout: 10_000 })
check(
  'the editor reads page.params.id and loads that track',
  (await page.locator('h1').textContent()) === track.title,
)
check(
  'its items are the stored ones, in stored order, shown by clip title not id',
  JSON.stringify(await titles()) === JSON.stringify(['e2e bright kaleid', 'e2e dark drift']),
  (await titles()).join(' → '),
)
check(
  'and they are this track’s items, not the other track’s',
  otherId !== track.id && (await page.locator('ol > li').count()) === 2,
)
check(
  'a section label saved earlier is shown in its field',
  (await page.locator('ol > li >> nth=1').locator('input[type="text"]').inputValue()) === 'outro',
)
await shot(page, '04-track-editor-loaded')

// --- reorder in the UI, save, reload: did it survive? ---
await page.locator('ol > li >> nth=0').locator('button[aria-label="Move down"]').click()
check(
  'the ↓ button swaps exactly two positions on screen',
  JSON.stringify(await titles()) === JSON.stringify(['e2e dark drift', 'e2e bright kaleid']),
  (await titles()).join(' → '),
)
check(
  'the first item’s ↑ is disabled — the no-op at the end of the list is made visible',
  await page.locator('ol > li >> nth=0').locator('button[aria-label="Move up"]').isDisabled(),
)
check(
  'the last item’s ↓ is disabled',
  await page.locator('ol > li >> nth=1').locator('button[aria-label="Move down"]').isDisabled(),
)
await page.click('button:has-text("Save")')
await page.waitForSelector('[role="status"]:has-text("Saved.")', { timeout: 10_000 })
await page.reload({ waitUntil: 'networkidle' })
await page.locator('ol > li').first().waitFor({ timeout: 10_000 })
check(
  'the new order survived a full page reload',
  JSON.stringify(await titles()) === JSON.stringify(['e2e dark drift', 'e2e bright kaleid']),
  (await titles()).join(' → '),
)
const stored = await readBack()
check(
  'and it is what the API reads back from D1',
  JSON.stringify(stored.items.map((i) => i.clipId)) ===
    JSON.stringify([clips.get('e2e dark drift').id, clips.get('e2e bright kaleid').id]),
)
await shot(page, '05-track-editor-reordered')

// --- §14.2: a commercial track refuses an uncleared clip, on screen, naming it ---
await page.selectOption('main > label select', 'commercial')
await page.click('button:has-text("Save")')
await page.waitForSelector('[role="alert"]', { timeout: 10_000 })
const refusal = flat(await page.locator('[role="alert"]').textContent())
check(
  'the §14.2 refusal reaches the screen naming the offending clip',
  refusal.includes('e2e bright kaleid'),
  refusal,
)
check('and says which item it is', /item \d/u.test(refusal), refusal)
check(
  'and nothing was stored — it is a refusal, not a warning over a completed write',
  (await readBack()).mode === 'noncommercial',
)
await shot(page, '06-track-editor-commercial-refusal')

check(
  'no uncaught page errors',
  pageErrors.filter((e) => !e.includes('400')).length === 0,
  pageErrors.join(' | '),
)
await done(browser)
