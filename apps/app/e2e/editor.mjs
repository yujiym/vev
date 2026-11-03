// SPDX-License-Identifier: AGPL-3.0-or-later
// Drives the Tracks and Track editor panels on the stage. What is under test: that the editor loads
// the items of the track it was opened on, that a reorder made in the UI survives a full reload of
// the stage (and matches what the API reads back from D1), and that the §14.2 commercial refusal
// reaches the screen naming the clip instead of dying in the network tab.
//
// Seeds its own clips and creates its own track, so it never depends on what an earlier run left
// behind. See ./README.md to run it.
import {
  BASE,
  check,
  done,
  flat,
  openBrowser,
  openPanel,
  openStage,
  panel,
  seedClips,
  seedTrack,
  shot,
} from './lib.mjs'

const clips = await seedClips()
const track = await seedTrack(clips)
const { browser, page, pageErrors } = await openBrowser()

const titles = async () => await panel(page).locator('ol > li strong').allTextContents()
const heading = () => panel(page).locator('h3.track-title')
const items = () => panel(page).locator('ol > li')
const openTrack = async (title) => {
  await openPanel(page, 'Tracks')
  await panel(page).getByRole('button', { exact: true, name: title }).click()
  await items().first().waitFor({ timeout: 10_000 })
}
const saved = async () => {
  await panel(page).getByRole('button', { exact: true, name: 'Save' }).click()
  await panel(page).locator('[role="status"]:has-text("Saved.")').waitFor({ timeout: 10_000 })
}
const readBack = async () => await (await fetch(`${BASE}/api/tracks/${track.id}`)).json()

// --- the track list, and the create form that opens a new editor ---
await openStage(page)
await openPanel(page, 'Tracks')
const row = panel(page).locator('ul li').filter({ hasText: track.title })
await row.first().waitFor({ timeout: 10_000 })
check(
  'the tracks index lists the saved track and its clip count',
  flat(await row.first().textContent()).includes('2 clips'),
  flat(await row.first().textContent()),
)

const createdTitle = `e2e created in the browser ${Date.now()}`
await panel(page).locator('input[type="text"]').fill(createdTitle)
await panel(page).getByRole('button', { exact: true, name: 'Create' }).click()
await heading().waitFor({ timeout: 10_000 })
check('creating a track opens its own editor, on the stage', (await heading().textContent()) === createdTitle)
check('a brand-new track opens empty', (await panel(page).textContent()).includes('no clips yet'))
check(
  'the editor did not leave the page, so the show is still mounted',
  new URL(page.url()).pathname === '/' && (await page.locator('canvas').first().isVisible()),
)

// Give the other track an item of its own — a DIFFERENT clip. Without this, "the editor loaded
// this track's items and not the other's" passes merely because the other track is empty, which
// proves nothing about the editor keying off `page.params.id`. Adding it through the picker also
// covers the append-and-save path that nothing else here touches.
await panel(page).locator('section.add-clip select').selectOption(clips.get('e2e textmode only').id)
await panel(page).locator('section.add-clip button').click()
await saved()
check(
  'a clip added through the picker is saved onto the track',
  JSON.stringify(await titles()) === JSON.stringify(['e2e textmode only']),
  (await titles()).join(' → '),
)

// --- opening another track from the list swaps the editor to THAT track's items ---
await panel(page).getByRole('button', { exact: true, name: 'All tracks' }).click()
await panel(page).getByRole('button', { exact: true, name: track.title }).click()
await items().first().waitFor({ timeout: 10_000 })
await page.waitForFunction(
  (title) => document.querySelector('aside:not([hidden]) h3.track-title')?.textContent === title,
  track.title,
  { timeout: 10_000 },
)
check('the editor loads the track it was opened on', (await heading().textContent()) === track.title)
check(
  'its items are the stored ones, in stored order, shown by clip title not id',
  JSON.stringify(await titles()) === JSON.stringify(['e2e bright kaleid', 'e2e dark drift']),
  (await titles()).join(' → '),
)
// Distinguished by CONTENT, not by count: the other track holds "e2e textmode only", which this one
// never does, so an editor that ignored the id would be caught.
check(
  'and they are this track’s items, not the other track’s',
  !(await titles()).includes('e2e textmode only'),
  `showing: ${(await titles()).join(', ')}`,
)
check(
  'a section label saved earlier is shown in its field',
  (await items().nth(1).locator('input[type="text"]').inputValue()) === 'outro',
)
await shot(page, '04-track-editor-loaded')

// --- reorder in the UI, save, reload: did it survive? ---
await items().nth(0).locator('button[aria-label="Move down"]').click()
check(
  'the ↓ button swaps exactly two positions on screen',
  JSON.stringify(await titles()) === JSON.stringify(['e2e dark drift', 'e2e bright kaleid']),
  (await titles()).join(' → '),
)
check(
  'the first item’s ↑ is disabled — the no-op at the end of the list is made visible',
  await items().nth(0).locator('button[aria-label="Move up"]').isDisabled(),
)
check(
  'the last item’s ↓ is disabled',
  await items().nth(1).locator('button[aria-label="Move down"]').isDisabled(),
)
await saved()
await page.reload({ waitUntil: 'networkidle' })
await page.locator('.row').waitFor({ timeout: 15_000 })
await openTrack(track.title)
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
await panel(page).locator('label.mode select').selectOption('commercial')
await panel(page).getByRole('button', { exact: true, name: 'Save' }).click()
await panel(page).locator('[role="alert"]').waitFor({ timeout: 10_000 })
const refusal = flat(await panel(page).locator('[role="alert"]').textContent())
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
