// SPDX-License-Identifier: AGPL-3.0-or-later
// Shared plumbing for the manual browser drivers in this directory. See ./README.md for what they
// check, what has to be running first, and what they deliberately do NOT prove.
//
// `playwright` is NOT a dependency of this repository, on purpose: these drivers are a manual
// check, not part of `pnpm test`, and nothing in the gate should pull a browser download. It is
// supplied by `npx --yes --package playwright@1.63.0 ...` (see ./README.md) — which is why it is
// loaded by `loadChromium` below rather than by a bare `import`. Keep that version and this
// comment in step.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'

export { BASE, seedClips, seedTrack } from './seed.mjs'

/** Where captures land. Git-ignored: they are evidence for the person running this, not artefacts. */
export const SHOTS = process.env.VEV_E2E_SHOTS ?? path.join(import.meta.dirname, 'screenshots')

let failures = 0

export const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail === '' ? '' : ` — ${detail}`}`)
  if (!ok) {
    failures += 1
  }
}

export const done = async (browser) => {
  await browser.close()
  console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`)
  process.exit(failures === 0 ? 0 : 1)
}

/**
 * Launches headless Chromium with SwiftShader, which is what makes WebGL work with no GPU.
 *
 * LIMITATION, and it is not a small one: SwiftShader is a software rasteriser. These drivers prove
 * that the render paths execute and that the compositor blends two clips — they say NOTHING about
 * frame rate, and nothing about how any of this behaves on a real projector. §15.2's performance
 * questions are untouched by everything in this directory.
 *
 * An explicit context, not `browser.newPage()`, so the playback driver can open the output window
 * as a second page sharing this origin — and therefore sharing the BroadcastChannel the control
 * panel publishes on. That two-window arrangement is the real one, not a simulation of it.
 */
/**
 * Finds playwright without it being a dependency here.
 *
 * `npx --package playwright@1.63.0 node <script>` puts playwright's BIN on `PATH` but sets no
 * `NODE_PATH` — and ESM ignores `NODE_PATH` anyway — so a bare `import 'playwright'` from a file
 * inside this repository does not resolve. Verified, not assumed: that invocation fails with
 * ERR_MODULE_NOT_FOUND. The bin it does expose is
 * `<npx cache>/node_modules/.bin/playwright`, so its sibling `node_modules` is a resolution root a
 * `createRequire` can use, and playwright is requireable from there.
 *
 * A plain `import` is still tried first, so this works unchanged for anyone who does have
 * playwright installed locally.
 */
const loadChromium = async () => {
  try {
    return (await import('playwright')).chromium
  } catch {
    let bin
    try {
      bin = execFileSync('sh', ['-c', 'command -v playwright'], { encoding: 'utf8' }).trim()
    } catch {
      bin = ''
    }
    if (bin === '') {
      throw new Error(
        'playwright is not on the module path. Run these drivers as: npx --yes --package playwright@1.63.0 node apps/web/e2e/<script>.mjs (see ./README.md)',
      )
    }
    const nodeModules = path.dirname(path.dirname(bin))
    return createRequire(path.join(nodeModules, 'anchor.cjs'))('playwright').chromium
  }
}

export const openBrowser = async () => {
  fs.mkdirSync(SHOTS, { recursive: true })
  const chromium = await loadChromium()
  const browser = await chromium.launch({ args: ['--use-gl=swiftshader'] })
  const context = await browser.newContext({ viewport: { height: 900, width: 1280 } })
  const page = await context.newPage()

  const apiCalls = []
  page.on('request', (request) => {
    const url = new URL(request.url())
    if (url.pathname.startsWith('/api/')) {
      apiCalls.push(url.pathname + url.search)
    }
  })

  const pageErrors = []
  page.on('pageerror', (error) => pageErrors.push(String(error)))
  page.on('console', (message) => {
    if (message.type() === 'error') {
      pageErrors.push(message.text())
    }
  })

  return { apiCalls, browser, context, page, pageErrors }
}

/**
 * Waits for `predicate` to hold in the page, and RETURNS whether it did instead of throwing.
 *
 * Two reasons this exists rather than calling `page.waitForFunction` directly.
 *
 * Its options are its THIRD argument — the second is the value handed to the predicate — so
 * `waitForFunction(fn, { timeout })` silently passes the options object as data and falls back to
 * the 30-second default. That mistake was documented in one driver here and then made in another,
 * and nothing catches it: `apps/web/e2e/**` is excluded from lint. Named options make it
 * unavailable rather than merely warned about.
 *
 * And it returns a boolean, so a caller can feed the real condition to `check` instead of letting
 * a rejection end the run with no FAIL line, no summary and a browser still open. A driver that
 * dies mid-way is a worse instrument than one that reports which check failed.
 */
export const until = async (page, predicate, { arg, timeout = 15_000 } = {}) => {
  try {
    await page.waitForFunction(predicate, arg, { timeout })
    return true
  } catch {
    return false
  }
}

export const shot = async (target, name) => await target.screenshot({ path: path.join(SHOTS, `${name}.png`) })

/** Collapses the whitespace a rendered template is full of, so a failure message is readable. */
export const flat = (text) => text.replaceAll(/\s+/gu, ' ').trim()
