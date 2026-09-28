// SPDX-License-Identifier: AGPL-3.0-or-later
import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const ACCESS_HEADERS = { 'Cf-Access-Jwt-Assertion': 'zzz-not-a-real-jwt-zzz' }

const minimalClipPayload = () => ({
  author: 'Khoparzi',
  code: 'osc(10, 0.1, 1.2).kaleid(4).out()',
  engine: 'hydra',
  license: 'CC BY 4.0',
  title: 'Aquatic blubs',
})

const readJson = async <T>(response: Response): Promise<T> =>
  // SAFETY: every call site below names the exact shape this suite's own route just produced —
  // asserting it here just gives the test body a typed value to read fields off of.
  await response.json()

const registerClip = async (): Promise<string> => {
  const response = await SELF.fetch('https://vev.test/api/clips', {
    body: JSON.stringify(minimalClipPayload()),
    headers: { 'content-type': 'application/json', ...ACCESS_HEADERS },
    method: 'POST',
  })
  const body = await readJson<{ id: string }>(response)
  return body.id
}

const uploadThumbnail = async (
  clipId: string,
  bytes: string,
  headers: Record<string, string> = ACCESS_HEADERS,
  query = '',
) =>
  await SELF.fetch(`https://vev.test/api/clips/${clipId}/thumbnail${query}`, {
    body: bytes,
    headers: { 'content-type': 'video/webm', ...headers },
    method: 'POST',
  })

/** The palette as the registration page measures it (`dominantColours`) — never a default. */
const MEASURED_PALETTE = ['#204060', '#f0e0c0', '#802040']
const paletteQuery = (colours: readonly string[]) =>
  `?${new URLSearchParams({ palette: colours.join(',') }).toString()}`

describe('POST /api/clips/:id/thumbnail', () => {
  it('stores the upload in MEDIA and records the key on the clip row', async () => {
    const clipId = await registerClip()

    const response = await uploadThumbnail(clipId, 'fake webm bytes')
    expect(response.status).toBe(201)

    const body = await readJson<{ thumbnailKey: string }>(response)
    expect(body.thumbnailKey).toBe(`thumbnails/${clipId}.webm`)

    const getResponse = await SELF.fetch(`https://vev.test/media/${body.thumbnailKey}`)
    expect(getResponse.status).toBe(200)
    await expect(getResponse.text()).resolves.toBe('fake webm bytes')
  })

  it('404s for a clip id with no matching row', async () => {
    const response = await uploadThumbnail('00000000-0000-0000-0000-000000000000', 'bytes')
    expect(response.status).toBe(404)
  })

  it('refuses an upload with no Access assertion header', async () => {
    const clipId = await registerClip()
    const response = await uploadThumbnail(clipId, 'bytes', {})
    expect(response.status).toBe(403)
  })

  it('rejects an empty body', async () => {
    const clipId = await registerClip()
    const response = await uploadThumbnail(clipId, '')
    expect(response.status).toBe(400)
  })

  it('stores the palette measured from the frames this recording captured', async () => {
    const clipId = await registerClip()

    const response = await uploadThumbnail(
      clipId,
      'fake webm bytes',
      ACCESS_HEADERS,
      paletteQuery(MEASURED_PALETTE),
    )
    expect(response.status).toBe(201)

    const row = await env.DB.prepare('select palette from clips where id = ?').bind(clipId).first()
    expect(JSON.parse(String(row?.palette))).toStrictEqual(MEASURED_PALETTE)
  })

  it('leaves palette null when the upload measured none', async () => {
    const clipId = await registerClip()
    await uploadThumbnail(clipId, 'fake webm bytes')

    const row = await env.DB.prepare('select palette from clips where id = ?').bind(clipId).first()
    expect(row?.palette).toBeNull()
  })

  it('rejects an unparseable palette rather than silently dropping it', async () => {
    const clipId = await registerClip()
    const response = await uploadThumbnail(clipId, 'bytes', ACCESS_HEADERS, '?palette=teal,#f0e0c0')
    expect(response.status).toBe(400)

    const row = await env.DB.prepare('select palette from clips where id = ?').bind(clipId).first()
    expect(row?.palette).toBeNull()
  })

  it('refuses a palette longer than any real measurement, so a row cannot be stuffed', async () => {
    const clipId = await registerClip()
    const tooMany = Array.from({ length: 9 }, (_unused, index) => `#00000${index}`)
    const response = await uploadThumbnail(clipId, 'bytes', ACCESS_HEADERS, paletteQuery(tooMany))
    expect(response.status).toBe(400)
  })
})

describe('GET /media/:key', () => {
  it('serves a stored thumbnail with a long cache lifetime and the stored content type', async () => {
    const clipId = await registerClip()
    const uploadResponse = await uploadThumbnail(clipId, 'fake webm bytes')
    const { thumbnailKey } = await readJson<{ thumbnailKey: string }>(uploadResponse)

    const response = await SELF.fetch(`https://vev.test/media/${thumbnailKey}`)

    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('video/webm')
    expect(response.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
  })

  it('refuses a public request with no Access header — the route is meant to work unauthenticated', async () => {
    const clipId = await registerClip()
    const uploadResponse = await uploadThumbnail(clipId, 'fake webm bytes')
    const { thumbnailKey } = await readJson<{ thumbnailKey: string }>(uploadResponse)

    const response = await SELF.fetch(`https://vev.test/media/${thumbnailKey}`, { headers: {} })

    expect(response.status).toBe(200)
  })

  it('404s a well-formed key that matches no clips row, even if it looks like a real thumbnail key', async () => {
    const response = await SELF.fetch(
      'https://vev.test/media/thumbnails/11111111-1111-1111-1111-111111111111.webm',
    )
    expect(response.status).toBe(404)
  })

  it('404s a key never uploaded at all', async () => {
    const response = await SELF.fetch('https://vev.test/media/not-a-real-key')
    expect(response.status).toBe(404)
  })
})
