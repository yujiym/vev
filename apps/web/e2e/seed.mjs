// SPDX-License-Identifier: AGPL-3.0-or-later
// Fixtures for the manual browser drivers in this directory. Idempotent: run it as often as you
// like. Everything it creates is named with the `e2e ` prefix, so it never collides with a clip a
// human registered, and every driver here asserts against those names rather than against totals
// — a library with other clips in it must not break them.
//
// Needs `pnpm live` running (see ./README.md).
import { execFileSync } from 'node:child_process'
import path from 'node:path'

export const BASE = 'http://127.0.0.1:8787'

const API_DIR = path.join(import.meta.dirname, '..', '..', 'api')

/** The five clips the library driver reads flags off, plus the two the playback driver crossfades between. */
const CLIPS = [
  {
    // Deliberately dark, slow and sparse: the outgoing half of a crossfade a still frame can show.
    code: 'osc(4, 0.05, 0.2).color(0.2, 0.3, 0.5).rotate(0.1).out()',
    commercialOk: true,
    engine: 'hydra',
    license: 'CC0 1.0',
    title: 'e2e dark drift',
  },
  {
    // Bright, dense, and nothing like the above — so "it blended" is visible rather than asserted.
    code: 'osc(40, 0.3, 2).kaleid(6).modulate(noise(4, 0.2)).contrast(1.6).out()',
    commercialOk: false,
    engine: 'hydra',
    license: 'CC BY-NC-SA 4.0',
    title: 'e2e bright kaleid',
  },
  { code: 'noise(3).out()', engine: 'hydra', license: 'CC BY 4.0', title: 'e2e pending annotation' },
  { code: 'noise(5).out()', engine: 'hydra', license: 'CC BY 4.0', title: 'e2e annotated and reviewed' },
  { code: 'noise(7).out()', engine: 'hydra', license: 'CC BY 4.0', title: 'e2e failed annotation' },
  { code: 'noise(9).out()', engine: 'hydra', license: 'unknown', title: 'e2e unknown licence' },
  {
    code: 'osc(8).out()',
    commercialOk: true,
    engine: 'textmode',
    license: 'CC0 1.0',
    title: 'e2e textmode only',
  },
]

const json = async (url, init) => {
  const response = await fetch(url, init)
  if (!response.ok) {
    throw new Error(`${init?.method ?? 'GET'} ${url} → ${response.status}: ${await response.text()}`)
  }
  return await response.json()
}

/**
 * Sets the four columns annotation owns. There is no API for them on purpose — they are
 * server-owned (Task 1's ruling) and written by the queue consumer — and annotation cannot run in
 * local mode at all: no AI binding, no queue (§15.3). So the two annotated states the library grid
 * has to tell apart are written straight into the local D1 file, which is the same file `pnpm
 * live` is serving from.
 */
const setAnnotationState = (sql) => {
  try {
    execFileSync(
      'npx',
      ['--yes', 'wrangler', 'd1', 'execute', 'vev', '--env', 'local', '--local', '--command', sql],
      {
        cwd: API_DIR,
        stdio: ['ignore', 'ignore', 'pipe'],
      },
    )
  } catch (error) {
    throw new Error(
      `seed: could not write annotation state into the local D1 file. Is \`pnpm live\` running, and has it applied migrations? (${error.message})`,
    )
  }
}

/** Registers anything missing, then forces the annotated states. Returns every e2e clip by title. */
export const seedClips = async () => {
  const existing = new Map((await json(`${BASE}/api/clips`)).clips.map((clip) => [clip.title, clip]))

  for (const clip of CLIPS) {
    if (!existing.has(clip.title)) {
      await json(`${BASE}/api/clips`, {
        body: JSON.stringify({ author: 'vev e2e', ...clip }),
        headers: { 'content-type': 'application/json' },
        method: 'POST',
      })
    }
  }

  setAnnotationState(
    "update clips set annotation_status='ok', reviewed=1, energy=3, tags='[\"calm\",\"abstract\"]' where title='e2e annotated and reviewed'",
  )
  setAnnotationState(
    "update clips set annotation_status='failed', reviewed=0, energy=null, tags=null where title='e2e failed annotation'",
  )

  const byTitle = new Map((await json(`${BASE}/api/clips`)).clips.map((clip) => [clip.title, clip]))
  for (const clip of CLIPS) {
    if (!byTitle.has(clip.title)) {
      throw new Error(`seed: "${clip.title}" is missing after seeding`)
    }
  }
  return byTitle
}

/**
 * Creates a fresh track for one run, so no driver ever depends on a track an earlier run left
 * behind. Item 1 is the bright clip and item 2 the dark one, so the first crossfade of a run goes
 * from the panel's dark start fixture into something visibly different.
 *
 * There is no DELETE route for tracks, so each run leaves one behind in the local database. That
 * is deliberate — a local dev D1 is scratch — but it is why the title carries a timestamp.
 */
export const seedTrack = async (clips) => {
  const bright = clips.get('e2e bright kaleid')
  const dark = clips.get('e2e dark drift')
  return await json(`${BASE}/api/tracks`, {
    body: JSON.stringify({
      defaultTransition: { bars: 2, kind: 'crossfade' },
      items: [
        { bars: 4, clipId: bright.id },
        { clipId: dark.id, section: 'outro' },
      ],
      mode: 'noncommercial',
      title: `e2e track ${new Date().toISOString()}`,
      visibility: 'private',
    }),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
}

if (import.meta.filename === process.argv[1]) {
  const clips = await seedClips()
  console.log(`seeded ${clips.size} clips; track: ${(await seedTrack(clips)).title}`)
}
