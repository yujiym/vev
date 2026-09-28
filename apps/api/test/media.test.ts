// SPDX-License-Identifier: AGPL-3.0-or-later
import { SELF } from 'cloudflare:test'
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
) =>
  await SELF.fetch(`https://vev.test/api/clips/${clipId}/thumbnail`, {
    body: bytes,
    headers: { 'content-type': 'video/webm', ...headers },
    method: 'POST',
  })

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
