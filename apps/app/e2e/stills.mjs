// SPDX-License-Identifier: AGPL-3.0-or-later
// Drives /studio/clips/new through probe, recording and save, and checks the stills that leave the
// browser: how many, that they are JPEGs inside TypeSafe's size limits, that they are not black,
// and that registration still saves. The capture path (a `drawImage` copy inside the render tick)
// needs a real WebGL canvas, so no unit test can reach it. See ./README.md to run it.
import fs from 'node:fs'
import path from 'node:path'

import { BASE, check, done, openBrowser, SHOTS, shot, until } from './lib.mjs'

const CODE = 'osc(18, 0.1, 1.4).color(0.9, 0.4, 0.2).kaleid(5).out()'

/** Width and height from the first start-of-frame marker. */
const jpegSize = (bytes) => {
  let offset = 2
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return undefined
    }
    const marker = bytes[offset + 1]
    const length = bytes.readUInt16BE(offset + 2)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) }
    }
    offset += 2 + length
  }
  return undefined
}

const { browser, page, pageErrors } = await openBrowser()

let stillsRequest
page.on('request', (request) => {
  if (request.url().endsWith('/stills') && request.method() === 'POST') {
    stillsRequest = request
  }
})

// Playwright cannot read a multipart body that carries a Blob, so the page copies the `still`
// parts as they go out. It only observes; the real request is untouched.
await page.addInitScript(() => {
  const realFetch = window.fetch
  window.fetch = async (input, init) => {
    if (String(input).endsWith('/stills') && init?.body instanceof FormData) {
      window.__stills = await Promise.all(
        init.body.getAll('still').map(async (part) => ({
          base64: btoa(String.fromCodePoint(...new Uint8Array(await part.arrayBuffer()))),
          type: part.type,
        })),
      )
    }
    return await realFetch(input, init)
  }
})

await page.goto(`${BASE}/studio/clips/new`, { waitUntil: 'networkidle' })
await page.locator('textarea').fill(CODE)
await page.getByRole('button', { name: 'Run probe' }).click()
const probed = await until(page, () => document.body.innerText.includes('Probe passed'))
check('the probe passes', probed)

await page.getByRole('button', { name: 'Record thumbnail' }).click()
const recorded = await until(page, () => document.body.innerText.includes('Annotation frames:'), {
  timeout: 20_000,
})
check('the recording finishes', recorded)
const frames = Number.parseInt((await page.locator('text=Annotation frames:').innerText()).split(':')[1], 10)
check('three annotation frames were captured', frames === 3, `got ${frames}`)

await page.getByRole('textbox', { name: 'Title' }).fill('e2e stills')
await page.getByRole('textbox', { name: 'Author' }).fill('e2e')
await page.getByRole('textbox', { name: 'Licence' }).fill('CC BY 4.0')
await page.getByRole('button', { name: 'Save clip' }).click()
const saved = await until(page, () => document.body.innerText.includes('Saved as'))
check('the clip saves', saved)

await until(page, () => true, { timeout: 500 })
const response = stillsRequest === undefined ? undefined : await stillsRequest.response()
check('the stills upload was sent and accepted', response?.status() === 201, `status ${response?.status()}`)
check(
  'no refusal is shown for the stills',
  !(await page.locator('body').innerText()).includes('frames were not uploaded'),
)

const sent = await page.evaluate(() => window.__stills ?? [])
check(
  'three JPEG parts were uploaded',
  sent.length === 3 && sent.every((part) => part.type === 'image/jpeg'),
  `got ${sent.length}`,
)
fs.mkdirSync(SHOTS, { recursive: true })
for (const [index, part] of sent.entries()) {
  const bytes = Buffer.from(part.base64, 'base64')
  fs.writeFileSync(path.join(SHOTS, `still-${index}.jpg`), bytes)
  const size = jpegSize(bytes)
  const inside =
    size !== undefined &&
    Math.min(size.width, size.height) >= 280 &&
    Math.max(size.width, size.height) <= 1568 &&
    size.width * size.height >= 78_400 &&
    size.width * size.height <= 2_458_624
  check(`still ${index} is a JPEG inside TypeSafe's limits`, inside, JSON.stringify(size))
  check(`still ${index} is smaller than 16 MiB`, bytes.length < 16 * 1024 * 1024, `${bytes.length} bytes`)
}

await shot(page, 'stills-registered')
check('the page raised no errors', pageErrors.length === 0, pageErrors.join(' | '))
await done(browser)
