// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Track } from '@vev/shared'
import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const ACCESS_HEADERS = { 'Cf-Access-Jwt-Assertion': 'zzz-not-a-real-jwt-zzz' }

const readJson = async <T>(response: Response): Promise<T> =>
  // SAFETY: every call site below names the exact shape this suite's own route just produced —
  // asserting it here just gives the test body a typed value to read fields off of.
  await response.json()

interface ClipOverrides {
  commercialOk?: boolean
  license?: string
  title?: string
}

/**
 * Registers a clip and returns its id. Tracks reference clips by id, so every track test needs
 * real rows to point at — the whole point of the existence check is that a made-up id fails.
 */
const registerClip = async (overrides: ClipOverrides = {}): Promise<string> => {
  const response = await SELF.fetch('https://vev.test/api/clips', {
    body: JSON.stringify({
      author: 'Khoparzi',
      code: 'osc(10, 0.1, 1.2).kaleid(4).out()',
      engine: 'hydra',
      license: 'CC BY 4.0',
      title: 'Aquatic blubs',
      ...overrides,
    }),
    headers: { 'content-type': 'application/json', ...ACCESS_HEADERS },
    method: 'POST',
  })
  expect(response.status).toBe(201)
  const body = await readJson<{ id: string }>(response)
  return body.id
}

interface TrackOverrides {
  items?: { bars?: number; clipId: string; section?: string }[]
  mode?: string
  title?: string
}

const newTrackPayload = (overrides: TrackOverrides = {}) => ({
  defaultTransition: { bars: 2, kind: 'crossfade' },
  items: [],
  mode: 'noncommercial',
  title: 'Opening set',
  visibility: 'private',
  ...overrides,
})

const postTrack = async (body: unknown, headers: Record<string, string> = ACCESS_HEADERS) =>
  await SELF.fetch('https://vev.test/api/tracks', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  })

const patchTrack = async (id: string, body: unknown) =>
  await SELF.fetch(`https://vev.test/api/tracks/${id}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...ACCESS_HEADERS },
    method: 'PATCH',
  })

/** Reads the stored order straight out of D1 — a 200 from the route proves nothing about the rows. */
const storedOrder = async (trackId: string): Promise<string[]> => {
  const { results } = await env.DB.prepare(
    'select clip_id from track_items where track_id = ? order by position',
  )
    .bind(trackId)
    .all<{ clip_id: string }>()
  return results.map((row) => row.clip_id)
}

const createTrack = async (overrides: TrackOverrides = {}): Promise<Track> =>
  await readJson<Track>(await postTrack(newTrackPayload(overrides)))

describe('POST /api/tracks', () => {
  it('creates a track and returns 201 with a server-generated slug', async () => {
    const response = await postTrack(newTrackPayload())
    expect(response.status).toBe(201)
    const body = await readJson<Track>(response)
    expect(body.slug).toContain('opening-set')
  })

  it('persists the items in the order they were sent', async () => {
    const first = await registerClip({ title: 'First' })
    const second = await registerClip({ title: 'Second' })
    const third = await registerClip({ title: 'Third' })

    const track = await createTrack({
      items: [{ clipId: first }, { clipId: second }, { clipId: third }],
    })

    await expect(storedOrder(track.id)).resolves.toStrictEqual([first, second, third])
  })

  it('refuses an item referencing a clip that does not exist, naming it', async () => {
    const real = await registerClip({ title: 'Real' })
    const response = await postTrack(
      newTrackPayload({ items: [{ clipId: real }, { clipId: 'no-such-clip' }] }),
    )

    expect(response.status).toBe(400)
    await expect(response.text()).resolves.toContain('no-such-clip')
  })

  it('writes no track row at all when one item is unresolvable', async () => {
    const before = await env.DB.prepare('select count(*) as n from tracks').first<{ n: number }>()
    await postTrack(newTrackPayload({ items: [{ clipId: 'no-such-clip' }] }))
    const after = await env.DB.prepare('select count(*) as n from tracks').first<{ n: number }>()

    expect(after?.n).toBe(before?.n)
  })

  it('refuses a commercial-mode track holding a clip that is not cleared for commercial use (§14.2)', async () => {
    const restricted = await registerClip({
      commercialOk: false,
      license: 'CC BY-NC-SA 4.0',
      title: 'Noncommercial only',
    })

    const response = await postTrack(newTrackPayload({ items: [{ clipId: restricted }], mode: 'commercial' }))

    expect(response.status).toBe(400)
    const message = await response.text()
    expect(message).toContain('Noncommercial only')
    expect(message).toContain(restricted)
  })

  it('accepts the same uncleared clip in a noncommercial track', async () => {
    const restricted = await registerClip({
      commercialOk: false,
      license: 'CC BY-NC-SA 4.0',
      title: 'Noncommercial only',
    })

    const response = await postTrack(
      newTrackPayload({ items: [{ clipId: restricted }], mode: 'noncommercial' }),
    )

    expect(response.status).toBe(201)
  })

  it('accepts a commercial-mode track whose clips are all cleared', async () => {
    const cleared = await registerClip({ commercialOk: true, license: 'CC0 1.0', title: 'Cleared' })
    const response = await postTrack(newTrackPayload({ items: [{ clipId: cleared }], mode: 'commercial' }))

    expect(response.status).toBe(201)
  })

  it('rejects a client-supplied ownerId rather than silently ignoring it', async () => {
    const response = await postTrack({ ...newTrackPayload(), ownerId: 'someone-else' })
    expect(response.status).toBe(400)
  })

  it('refuses a request with no Access assertion header', async () => {
    const response = await postTrack(newTrackPayload(), {})
    expect(response.status).toBe(403)
  })
})

describe('GET /api/tracks/:id', () => {
  it('returns the track with its items in stored order', async () => {
    const first = await registerClip({ title: 'First' })
    const second = await registerClip({ title: 'Second' })
    const created = await createTrack({
      items: [{ bars: 4, clipId: first, section: 'intro' }, { clipId: second }],
    })

    const response = await SELF.fetch(`https://vev.test/api/tracks/${created.id}`, {
      headers: ACCESS_HEADERS,
    })
    expect(response.status).toBe(200)
    const body = await readJson<Track>(response)

    expect(body.items.map((item) => item.clipId)).toStrictEqual([first, second])
  })

  it('reads an overridden item back, and an un-overridden one as absent rather than SQL NULL', async () => {
    const first = await registerClip({ title: 'First' })
    const second = await registerClip({ title: 'Second' })
    const created = await createTrack({
      items: [{ bars: 4, clipId: first, section: 'intro' }, { clipId: second }],
    })

    const body = await readJson<Track>(
      await SELF.fetch(`https://vev.test/api/tracks/${created.id}`, { headers: ACCESS_HEADERS }),
    )

    expect(body.items[0]).toStrictEqual({ bars: 4, clipId: first, section: 'intro' })
    expect(body.items[1]).toStrictEqual({ clipId: second })
  })

  it('404s for a track that does not exist', async () => {
    const response = await SELF.fetch('https://vev.test/api/tracks/no-such-track', {
      headers: ACCESS_HEADERS,
    })
    expect(response.status).toBe(404)
  })
})

describe('GET /api/tracks', () => {
  it('lists tracks with their items', async () => {
    const clip = await registerClip({ title: 'Listed' })
    const created = await createTrack({ items: [{ clipId: clip }], title: 'A listed track' })

    const response = await SELF.fetch('https://vev.test/api/tracks', { headers: ACCESS_HEADERS })
    expect(response.status).toBe(200)
    const body = await readJson<{ tracks: Track[] }>(response)

    const found = body.tracks.find((track) => track.id === created.id)
    expect(found?.items.map((item) => item.clipId)).toStrictEqual([clip])
  })
})

describe('PATCH /api/tracks/:id', () => {
  it('persists a reorder rather than only reporting one', async () => {
    const first = await registerClip({ title: 'First' })
    const second = await registerClip({ title: 'Second' })
    const third = await registerClip({ title: 'Third' })
    const created = await createTrack({
      items: [{ clipId: first }, { clipId: second }, { clipId: third }],
    })

    const response = await patchTrack(created.id, {
      items: [{ clipId: third }, { clipId: first }, { clipId: second }],
    })
    expect(response.status).toBe(200)

    await expect(storedOrder(created.id)).resolves.toStrictEqual([third, first, second])
  })

  it('leaves no orphaned rows from the replaced order', async () => {
    const first = await registerClip({ title: 'First' })
    const second = await registerClip({ title: 'Second' })
    const created = await createTrack({ items: [{ clipId: first }, { clipId: second }] })

    await patchTrack(created.id, { items: [{ clipId: second }] })

    await expect(storedOrder(created.id)).resolves.toStrictEqual([second])
  })

  it('updates the title without touching the items', async () => {
    const clip = await registerClip({ title: 'Kept' })
    const created = await createTrack({ items: [{ clipId: clip }] })

    const body = await readJson<Track>(await patchTrack(created.id, { title: 'Renamed' }))

    expect(body.title).toBe('Renamed')
    await expect(storedOrder(created.id)).resolves.toStrictEqual([clip])
  })

  it('applies a metadata change and a reorder as one edit', async () => {
    const first = await registerClip({ title: 'First' })
    const second = await registerClip({ title: 'Second' })
    const created = await createTrack({ items: [{ clipId: first }, { clipId: second }] })

    const body = await readJson<Track>(
      await patchTrack(created.id, {
        items: [{ clipId: second }, { clipId: first }],
        title: 'Renamed and reordered',
      }),
    )

    // Both halves travel in one D1 batch, so there is no window where the title moved and the
    // items did not — which is the state a performer would be left in by a torn write.
    expect(body.title).toBe('Renamed and reordered')
    await expect(storedOrder(created.id)).resolves.toStrictEqual([second, first])
  })

  it('refuses a reorder that introduces a clip which does not exist', async () => {
    const clip = await registerClip({ title: 'Kept' })
    const created = await createTrack({ items: [{ clipId: clip }] })

    const response = await patchTrack(created.id, {
      items: [{ clipId: 'no-such-clip' }, { clipId: clip }],
    })
    expect(response.status).toBe(400)
    await expect(storedOrder(created.id)).resolves.toStrictEqual([clip])
  })

  it('refuses switching to commercial mode while an uncleared clip is still in the track (§14.2)', async () => {
    const restricted = await registerClip({
      commercialOk: false,
      license: 'CC BY-NC-SA 4.0',
      title: 'Noncommercial only',
    })
    const created = await createTrack({ items: [{ clipId: restricted }] })

    const response = await patchTrack(created.id, { mode: 'commercial' })
    expect(response.status).toBe(400)
    await expect(response.text()).resolves.toContain('Noncommercial only')
  })

  it('leaves the stored mode alone when the commercial switch is refused', async () => {
    const restricted = await registerClip({
      commercialOk: false,
      license: 'CC BY-NC-SA 4.0',
      title: 'Noncommercial only',
    })
    const created = await createTrack({ items: [{ clipId: restricted }] })

    await patchTrack(created.id, { mode: 'commercial' })

    const row = await env.DB.prepare('select mode from tracks where id = ?')
      .bind(created.id)
      .first<{ mode: string }>()
    expect(row?.mode).toBe('noncommercial')
  })

  it('404s for a track that does not exist', async () => {
    const response = await patchTrack('no-such-track', { title: 'Renamed' })
    expect(response.status).toBe(404)
  })

  it('rejects an unknown field rather than silently dropping it', async () => {
    const created = await createTrack()
    const response = await patchTrack(created.id, { ownerId: 'someone-else' })
    expect(response.status).toBe(400)
  })
})
