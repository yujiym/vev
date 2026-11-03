// SPDX-License-Identifier: AGPL-3.0-or-later
// Drives what only the one-screen stage has: the picture under every overlay, thumbnails that hold
// still until looked at, what a reload keeps, old bookmarks, the source offer, and registration
// beside the live picture. It also writes the screenshots a person has to look at, because whether
// an overlay is readable over a white clip is not something a script can judge.
//
// See ./README.md to run it.
import {
  BASE,
  check,
  done,
  flat,
  nowTitle,
  openBrowser,
  openPanel,
  openStage,
  panel,
  pictureFrame,
  rowButton,
  seedClips,
  shot,
  showNow,
  until,
} from './lib.mjs'

const clips = await seedClips()
const { browser, context, page, pageErrors } = await openBrowser()

const thumbClip = clips.get('e2e with thumbnail')
const white = clips.get('e2e white')
const black = clips.get('e2e black')

// --- a real recording for one clip, made by a real MediaRecorder ---
await page.goto(`${BASE}/some/page/that/does/not/exist`, { waitUntil: 'networkidle' })
check(
  'an unmatched path still answers with the app’s own not-found page',
  (await page.textContent('body')).includes('Not found'),
)
const thumbnailStatus = await page.evaluate(async (clipId) => {
  const canvas = document.createElement('canvas')
  canvas.width = 320
  canvas.height = 180
  const context2d = canvas.getContext('2d')
  const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' })
  const parts = []
  recorder.addEventListener('dataavailable', (event) => parts.push(event.data))
  const stopped = new Promise((resolve) => recorder.addEventListener('stop', resolve))
  recorder.start()
  const started = performance.now()
  await new Promise((resolve) => {
    const paint = () => {
      const elapsed = performance.now() - started
      context2d.fillStyle = `hsl(${(elapsed / 4) % 360} 90% 55%)`
      context2d.fillRect(0, 0, 320, 180)
      if (elapsed < 1200) {
        requestAnimationFrame(paint)
      } else {
        resolve()
      }
    }
    paint()
  })
  recorder.stop()
  await stopped
  const response = await fetch(`/api/clips/${clipId}/thumbnail`, {
    body: new Blob(parts, { type: 'video/webm' }),
    headers: { 'content-type': 'video/webm' },
    method: 'POST',
  })
  return response.status
}, thumbClip.id)
check(
  'a recorded thumbnail was uploaded for a seeded clip',
  thumbnailStatus < 300,
  `status ${thumbnailStatus}`,
)

// A candidate answer with that clip in it, so which cards appear is not up to the ranking.
const answer = (ids) => ({
  candidates: ids.map((clipId, index) => ({
    clipId,
    reason: 'driver',
    score: 1 - index / 10,
    source: 'fallback',
  })),
  suggestedTransition: { bars: 0, kind: 'cut' },
})
const pool = [
  thumbClip.id,
  clips.get('e2e dark drift').id,
  clips.get('e2e bright kaleid').id,
  clips.get('e2e annotated and reviewed').id,
]
await page.route('**/api/candidates', async (route) => {
  // As the real route does, never offering what is on screen.
  const { currentClipId } = route.request().postDataJSON()
  const offered = pool.filter((id) => id !== currentClipId).slice(0, 3)
  await route.fulfill({ body: JSON.stringify(answer(offered)), contentType: 'application/json' })
})

// --- old bookmarks land on the stage ---
for (const path of ['/studio', '/studio/clips/new', '/studio/tracks/abc', '/output']) {
  const response = await page.goto(`${BASE}${path}`, { waitUntil: 'commit' })
  check(
    `${path} lands on the stage`,
    new URL(page.url()).pathname === '/',
    `${response?.status()} ${page.url()}`,
  )
}

await openStage(page)
await until(page, () => document.querySelectorAll('.card').length === 3, { timeout: 20_000 })
await page.waitForTimeout(800)

// --- what the screen shows by default ---
await shot(page, '30-stage-default')
check(
  'the picture fills the viewport',
  await page.evaluate(() => {
    const box = document.querySelector('canvas').getBoundingClientRect()
    return box.width === window.innerWidth && box.height === window.innerHeight
  }),
)
check(
  'no info overlay is on by default',
  (await page.locator('.overlay').count()) === 0,
  `${await page.locator('.overlay').count()} overlays`,
)
check('no panel is open by default', (await panel(page).count()) === 0)
check(
  'the AGPL source link is on the stage, naming the commit',
  /\/tree\/[0-9a-f]+$|github\.com\/[^/]+\/vev/u.test(
    (await page.locator('footer a').getAttribute('href')) ?? '',
  ),
  await page.locator('footer a').getAttribute('href'),
)
check(
  'and it is clickable, not under the picture',
  await page.evaluate(() => {
    const link = document.querySelector('footer a')
    const box = link.getBoundingClientRect()
    return document.elementFromPoint(box.x + 2, box.y + 2) === link
  }),
)

// --- a thumbnail shows its first frame, paused, and plays only when looked at ---
const video = page.locator('.card video')
check(
  'the clip with a recording shows a video element in its card',
  (await video.count()) === 1,
  `${await video.count()} videos`,
)
const firstFrame = await video.evaluate(async (element) => {
  if (element.readyState < 2) {
    await new Promise((resolve) => element.addEventListener('loadeddata', resolve, { once: true }))
  }
  const canvas = document.createElement('canvas')
  canvas.width = 16
  canvas.height = 9
  const context2d = canvas.getContext('2d')
  context2d.drawImage(element, 0, 0, 16, 9)
  const { data } = context2d.getImageData(8, 4, 1, 1)
  return { lit: data[0] + data[1] + data[2], paused: element.paused, width: element.videoWidth }
})
check(
  'it has decoded a frame with real pixels in it',
  firstFrame.lit > 30 && firstFrame.width > 0,
  JSON.stringify(firstFrame),
)
check('and it is paused, so it costs no decoding during the show', firstFrame.paused)
await shot(page, '31-stage-thumbnail')
await page.locator('.card').first().hover()
const playing = await until(page, () => {
  const element = document.querySelector('.card video')
  return !element.paused && element.currentTime > 0
})
check('hovering plays it', playing)
await page.mouse.move(640, 400)
check('leaving pauses it again', await until(page, () => document.querySelector('.card video').paused))
await page.locator('.card').first().focus()
check('focus plays it too', await until(page, () => !document.querySelector('.card video').paused))
await page.evaluate(() => document.activeElement.blur())

// --- a chosen card, and the cards button ---
// Early in a bar: screenshots are slow under software rendering, and the switch fires on the next one.
await showNow(page)
const earlyInBar = async () =>
  await until(
    page,
    () => Number.parseInt(document.querySelector('.phase div')?.style.width ?? '100', 10) < 15,
    {
      timeout: 5000,
    },
  )
await until(page, () => !document.body.textContent.includes('Fade in progress'), { timeout: 15_000 })
await earlyInBar()
await page.locator('.card').nth(1).click()
check('a chosen card has its outline', (await page.locator('.card.chosen').count()) === 1)
await shot(page, '32-stage-chosen')
await until(
  page,
  () => !document.querySelector('.card.chosen') && !document.body.textContent.includes('Fade in progress'),
  { timeout: 15_000 },
)
await earlyInBar()
await page.locator('.card').nth(1).click()
await rowButton(page, 'Cards').click()
check('the cards button hides them', (await page.locator('.card').count()) === 0)
check(
  'and the armed clip is still named while they are hidden',
  (await page.locator('.notices').textContent()).includes('Next:'),
  flat(await page.locator('.notices').textContent()),
)
await rowButton(page, 'Cards').click()
check('and shows them again', await until(page, () => document.querySelectorAll('.card').length === 3))
await until(page, () => !document.querySelector('.card.chosen'), { timeout: 15_000 })

// --- a panel over the running show, with panic one click away ---
await openPanel(page, 'Library')
await shot(page, '33-stage-panel')
const beforePanel = await pictureFrame(page)
await page.waitForTimeout(700)
check('the picture keeps moving behind an open panel', beforePanel !== (await pictureFrame(page)))
check('the URL did not change, so the show was not unmounted', new URL(page.url()).pathname === '/')
await rowButton(page, 'Blackout').click()
check('Blackout is one click away with a panel open', (await page.locator('.blackout').count()) === 1)
await shot(page, '34-stage-blackout-with-panel')
await rowButton(page, 'Blackout').click()
await rowButton(page, 'Freeze').click()
check('so is Freeze', (await rowButton(page, 'Freeze').getAttribute('aria-pressed')) === 'true')
await rowButton(page, 'Freeze').click()
await rowButton(page, 'Library').click()

// --- the info overlays ---
await rowButton(page, 'Credit').click()
await rowButton(page, 'Code').click()
await rowButton(page, 'Keys').click()
const playingTitle = await nowTitle(page)
check(
  'the credit overlay reads title, author and licence',
  await until(page, () => document.querySelector('.credit')?.textContent?.includes('vev e2e'), {
    timeout: 5000,
  }),
  flat(await page.locator('.credit').textContent()),
)
check(
  'and names the clip on screen',
  flat(await page.locator('.credit').textContent()).startsWith(`${playingTitle} —`),
)
check(
  'the code overlay shows that clip’s code',
  (await page.locator('.code pre').textContent()).includes('.out()'),
  await page.locator('.code pre').textContent(),
)
await shot(page, '35-stage-info-overlays')
await page.keyboard.press('b')
await shot(page, '36-stage-blackout')
check(
  'overlays stay up during a blackout',
  (await page.locator('.credit').isVisible()) && (await page.locator('.blackout').count()) === 1,
)
await page.keyboard.press('b')

// --- readable over the two extremes ---
const showClip = async (clipId, name) => {
  await page.evaluate((id) => {
    const memory = JSON.parse(sessionStorage.getItem('vev:show'))
    sessionStorage.setItem('vev:show', JSON.stringify({ ...memory, clipId: id }))
    // The next line stops the page writing the old clip back during the unload.
    Object.defineProperty(Storage.prototype, 'setItem', { value: () => undefined })
  }, clipId)
  await page.reload({ waitUntil: 'networkidle' })
  await until(page, () => document.querySelectorAll('.card').length === 3, { timeout: 20_000 })
  await rowButton(page, 'Credit').click()
  await rowButton(page, 'Code').click()
  await rowButton(page, 'Keys').click()
  await rowButton(page, 'Now').click()
  await page.locator('.card').nth(1).click()
  await page.waitForTimeout(150)
  await shot(page, name)
  await until(page, () => !document.querySelector('.card.chosen'), { timeout: 15_000 })
}
await showClip(white.id, '37-stage-over-white')
await showClip(black.id, '38-stage-over-black')

// --- what a reload keeps ---
await page.goto(`${BASE}/`, { waitUntil: 'networkidle' })
await showNow(page)
await until(page, () => document.querySelectorAll('.card').length === 3, { timeout: 20_000 })
await page.locator('.card').nth(2).click()
const keptTitle = flat((await page.locator('.card.chosen .candidate-title').textContent()) ?? '')
check(
  'the chosen clip lands before the reload',
  await until(page, (title) => document.querySelector('.now-title')?.textContent?.includes(title), {
    arg: keptTitle,
    timeout: 15_000,
  }),
)
await until(page, () => !document.body.textContent.includes('Fade in progress'), { timeout: 15_000 })
await rowButton(page, 'TAP').click()
await page.waitForTimeout(250)
await rowButton(page, 'TAP').click()
const tempo = flat(await page.locator('.bpm').textContent())
check('tapping moved the tempo', tempo !== '120 BPM', tempo)
await rowButton(page, 'Blackout').click()

const dialogs = []
page.on('dialog', (dialog) => dialogs.push(dialog.type()))
await page.reload({ waitUntil: 'networkidle' })
check(
  'a reload asks first, because it forgets the track and the direction',
  dialogs.includes('beforeunload'),
  dialogs.join(' '),
)
await page.locator('.row').waitFor({ timeout: 15_000 })
check(
  'a blackout is still up after a reload, so a covered picture stays covered',
  await until(page, () => document.querySelector('.blackout') !== null),
)
await rowButton(page, 'Blackout').click()
await rowButton(page, 'Now').click()
check('the same clip comes back', (await nowTitle(page)) === keptTitle, await nowTitle(page))
check(
  'the same tempo comes back',
  flat(await page.locator('.bpm').textContent()) === tempo,
  flat(await page.locator('.bpm').textContent()),
)

// --- registration beside the live picture ---
await until(page, () => document.querySelectorAll('.card').length === 3, { timeout: 20_000 })
await openPanel(page, 'New clip')
const form = panel(page)
check('the panel warns that the show shares its GPU', (await form.textContent()).includes('share its GPU'))
await form.locator('textarea').fill('osc(5).out()')
await page.keyboard.type(' ')
check(
  'a key typed in the code field stays in the code field',
  (await form.locator('textarea').inputValue()) === 'osc(5).out() ',
)
await form.locator('textarea').fill('osc(5).out()')
await page.locator('.card').first().click()
// Whichever side of the bar the check lands on: armed, or already fading. Both refuse, and say so.
check(
  'a probe is refused while a switch is armed or fading, and says why',
  (await form.getByRole('button', { name: 'Run probe' }).isDisabled()) &&
    /A switch is armed|A fade is running/u.test(await form.textContent()),
  flat(await form.locator('.refusal').textContent()),
)
await until(page, () => !document.querySelector('aside:not([hidden]) .refusal'), { timeout: 15_000 })

const moving = async () => {
  const before = await pictureFrame(page)
  await page.waitForTimeout(600)
  return before !== (await pictureFrame(page))
}
check('the picture moves before the probe', await moving())
await form.getByRole('button', { name: 'Run probe' }).click()
check(
  'a probe still runs when nothing is in flight',
  await until(page, () => document.body.innerText.includes('Probe passed')),
  flat(await form.innerText()).slice(0, 500),
)
check('the picture still moves after a probe', await moving())

// A probe whose WebGL fails outright must end in a message, with the show untouched.
await page.evaluate(() => {
  const real = HTMLCanvasElement.prototype.getContext
  window.__realGetContext = real
  HTMLCanvasElement.prototype.getContext = function getContext(kind, ...rest) {
    return this.closest('aside') !== null && kind.includes('webgl') ? null : real.call(this, kind, ...rest)
  }
})
await form.locator('textarea').fill('osc(6).out()')
await form.getByRole('button', { name: 'Run probe' }).click()
check(
  'a probe whose context cannot be created ends in a message',
  await until(page, () =>
    document.querySelector('aside:not([hidden]) [role="alert"]')?.textContent?.includes('Probe failed'),
  ),
  flat(await form.innerText()).slice(0, 500),
)
await page.evaluate(() => {
  HTMLCanvasElement.prototype.getContext = window.__realGetContext
})
check('and the picture is still moving', await moving())

// Losing the probe's context mid-recording must cost that recording and nothing else.
await form.locator('textarea').fill('osc(7).out()')
await form.getByRole('button', { name: 'Run probe' }).click()
await until(page, () => document.body.innerText.includes('Probe passed'))
await form.getByRole('button', { name: 'Record thumbnail' }).click()
await page.waitForTimeout(500)
const lostRecording = await page.evaluate(() => {
  // The canvas in the recording's own section: asking an idle canvas for a context would create one.
  const canvas = document.querySelector('aside:not([hidden]) section canvas')
  const gl = canvas?.getContext('webgl') ?? canvas?.getContext('experimental-webgl')
  const extension = gl?.getExtension('WEBGL_lose_context')
  if (!extension || gl.isContextLost()) {
    return false
  }
  extension.loseContext()
  return true
})
check('the recording’s own context was lost on purpose, mid-recording', lostRecording)
const recordingEnded = await until(page, () => !document.body.innerText.includes('Recording…'), {
  timeout: 15_000,
})
check('the recording ended rather than hanging', recordingEnded, flat(await form.innerText()).slice(-160))
check('the show survives a lost registration context', await moving())

// --- fullscreen ---
await rowButton(page, 'Fullscreen').click()
check(
  'the fullscreen button takes the whole document fullscreen',
  await until(page, () => document.fullscreenElement === document.documentElement),
)
check('and the row is still there', await rowButton(page, 'Blackout').isVisible())
await rowButton(page, 'Fullscreen').click()
check('and leaves again', await until(page, () => document.fullscreenElement === null))

// --- a lost live context is said out loud ---
await page.evaluate(() => {
  const canvas = document.querySelector('.stage > canvas')
  const gl = canvas.getContext('webgl') ?? canvas.getContext('webgl2')
  gl.getExtension('WEBGL_lose_context').loseContext()
})
check(
  'a lost live context puts a notice on screen instead of a silent black picture',
  await until(page, () => document.querySelector('.notices')?.textContent?.includes('lost its GPU context')),
)
await shot(page, '39-stage-context-lost')

const allowed = pageErrors.filter(
  (entry) =>
    !entry.includes('lost its GPU context') &&
    !entry.includes('WebGL') &&
    !entry.includes('webgl') &&
    !entry.includes('captureThumbnail') &&
    !entry.includes('CONTEXT_LOST'),
)
check('no other page errors', allowed.length === 0, allowed.join(' | '))
await context.close()
await done(browser)
