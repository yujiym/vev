// SPDX-License-Identifier: AGPL-3.0-or-later
import { createExecutionContext, env, SELF, waitOnExecutionContext } from 'cloudflare:test'
import * as v from 'valibot'
import { describe, expect, it, vi } from 'vitest'

import worker from '../src/index.ts'

const ACCESS_HEADERS = { 'Cf-Access-Jwt-Assertion': 'zzz-not-a-real-jwt-zzz' }

const registerClip = async (): Promise<string> => {
  const response = await SELF.fetch('https://vev.test/api/clips', {
    body: JSON.stringify({
      author: 'Khoparzi',
      code: 'osc(10, 0.1, 1.2).kaleid(4).out()',
      engine: 'hydra',
      license: 'CC BY 4.0',
      title: 'Aquatic blubs',
    }),
    headers: { 'content-type': 'application/json', ...ACCESS_HEADERS },
    method: 'POST',
  })
  const { id } = v.parse(v.object({ id: v.string() }), await response.json())
  return id
}

/** SOI plus an APP0 marker, then a distinguishing tail: enough to be a JPEG to the route's own check. */
const jpegBytes = (tail: number): Uint8Array => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, tail, tail])

const stillsBody = (parts: readonly Uint8Array[], type = 'image/jpeg'): FormData => {
  const form = new FormData()
  for (const [index, part] of parts.entries()) {
    form.append('still', new File([part], `still-${index}.jpg`, { type }))
  }
  return form
}

const uploadStills = async (
  clipId: string,
  body: FormData,
  headers: Record<string, string> = ACCESS_HEADERS,
) => await SELF.fetch(`https://vev.test/api/clips/${clipId}/stills`, { body, headers, method: 'POST' })

const storedKeys = async (clipId: string): Promise<string[] | null> => {
  const row = await env.DB.prepare('select still_keys from clips where id = ?')
    .bind(clipId)
    .first<{ still_keys: string | null }>()
  const raw = row?.still_keys ?? ''
  return raw === '' ? null : v.parse(v.array(v.string()), JSON.parse(raw))
}

describe('POST /api/clips/:id/stills', () => {
  it('stores each JPEG in MEDIA in recording order and records the keys on the clip row', async () => {
    const clipId = await registerClip()

    const response = await uploadStills(clipId, stillsBody([jpegBytes(1), jpegBytes(2), jpegBytes(3)]))
    expect(response.status).toBe(201)

    const keys = v.parse(v.object({ stillKeys: v.array(v.string()) }), await response.json()).stillKeys
    expect(keys).toHaveLength(3)
    expect(keys.every((key) => key.startsWith(`stills/${clipId}/`) && key.endsWith('.jpg'))).toBe(true)
    await expect(storedKeys(clipId)).resolves.toStrictEqual(keys)
    const stored = await Promise.all(
      keys.map(async (key) => {
        const object = await env.MEDIA.get(key)
        return {
          bytes: [...new Uint8Array((await object?.arrayBuffer()) ?? new ArrayBuffer(0))],
          contentType: object?.httpMetadata?.contentType,
        }
      }),
    )
    expect(stored).toStrictEqual(
      [1, 2, 3].map((tail) => ({ bytes: [...jpegBytes(tail)], contentType: 'image/jpeg' })),
    )
  })

  it('does not serve stills from the public media route', async () => {
    const clipId = await registerClip()
    await uploadStills(clipId, stillsBody([jpegBytes(1)]))
    const [key] = (await storedKeys(clipId)) ?? []
    const response = await SELF.fetch(`https://vev.test/media/${key}`)
    expect(response.status).toBe(404)
  })

  it('does not leak the keys into the clip the API returns', async () => {
    const clipId = await registerClip()
    await uploadStills(clipId, stillsBody([jpegBytes(1)]))
    const response = await SELF.fetch(`https://vev.test/api/clips/${clipId}`, { headers: ACCESS_HEADERS })
    expect(response.status).toBe(200)
    expect(Object.keys(await response.json())).not.toContain('stillKeys')
  })

  it('replaces a set with fresh keys and deletes every object of the old one', async () => {
    const clipId = await registerClip()
    await uploadStills(clipId, stillsBody([jpegBytes(1), jpegBytes(2), jpegBytes(3)]))
    const first = (await storedKeys(clipId)) ?? []

    const response = await uploadStills(clipId, stillsBody([jpegBytes(4)]))
    expect(response.status).toBe(201)

    const second = (await storedKeys(clipId)) ?? []
    expect(second).toHaveLength(1)
    expect(first.some((key) => second.includes(key))).toBe(false)
    const listed = await env.MEDIA.list({ prefix: `stills/${clipId}/` })
    expect(listed.objects.map((object) => object.key)).toStrictEqual(second)
  })

  it('leaves the existing set whole when a replacement fails part-way', async () => {
    const clipId = await registerClip()
    await uploadStills(clipId, stillsBody([jpegBytes(1), jpegBytes(2), jpegBytes(3)]))
    const first = (await storedKeys(clipId)) ?? []

    let puts = 0
    const failing = {
      delete: async (keys: string | string[]) => {
        await env.MEDIA.delete(keys)
      },
      get: async (key: string) => await env.MEDIA.get(key),
      list: async (options?: R2ListOptions) => await env.MEDIA.list(options),
      put: async (key: string, value: ArrayBuffer, options?: R2PutOptions) => {
        puts += 1
        if (puts === 2) {
          throw new Error('R2 unavailable')
        }
        return await env.MEDIA.put(key, value, options)
      },
    } as unknown as R2Bucket
    const consoleError = vi.spyOn(console, 'error').mockReturnValue()
    const ctx = createExecutionContext()
    const response = await worker.fetch(
      new Request(`https://vev.test/api/clips/${clipId}/stills`, {
        body: stillsBody([jpegBytes(7), jpegBytes(8), jpegBytes(9)]),
        headers: ACCESS_HEADERS,
        method: 'POST',
      }),
      { ...env, MEDIA: failing },
      ctx,
    )
    await waitOnExecutionContext(ctx)
    consoleError.mockRestore()

    expect(response.status).toBeGreaterThanOrEqual(500)
    await expect(storedKeys(clipId)).resolves.toStrictEqual(first)
    const bytes = await Promise.all(
      first.map(async (key) => {
        const object = await env.MEDIA.get(key)
        return [...new Uint8Array((await object?.arrayBuffer()) ?? [])]
      }),
    )
    expect(bytes).toStrictEqual([1, 2, 3].map((tail) => [...jpegBytes(tail)]))
    const listed = await env.MEDIA.list({ prefix: `stills/${clipId}/` })
    expect(listed.objects.map((object) => object.key).toSorted()).toStrictEqual([...first].toSorted())
  })

  it('still answers 201 when deleting the old objects fails, because the new set is already recorded', async () => {
    const clipId = await registerClip()
    await uploadStills(clipId, stillsBody([jpegBytes(1), jpegBytes(2)]))

    const brokenDelete = {
      delete: async () => await Promise.reject(new Error('R2 unavailable')),
      get: async (key: string) => await env.MEDIA.get(key),
      list: async (options?: R2ListOptions) => await env.MEDIA.list(options),
      put: async (key: string, value: ArrayBuffer, options?: R2PutOptions) =>
        await env.MEDIA.put(key, value, options),
    } as unknown as R2Bucket
    const consoleError = vi.spyOn(console, 'error').mockReturnValue()
    const ctx = createExecutionContext()
    const response = await worker.fetch(
      new Request(`https://vev.test/api/clips/${clipId}/stills`, {
        body: stillsBody([jpegBytes(5)]),
        headers: ACCESS_HEADERS,
        method: 'POST',
      }),
      { ...env, MEDIA: brokenDelete },
      ctx,
    )
    await waitOnExecutionContext(ctx)
    consoleError.mockRestore()

    expect(response.status).toBe(201)
    await expect(storedKeys(clipId)).resolves.toHaveLength(1)
  })

  it('404s for a clip id with no matching row', async () => {
    const response = await uploadStills('00000000-0000-0000-0000-000000000000', stillsBody([jpegBytes(1)]))
    expect(response.status).toBe(404)
  })

  it('refuses an upload with no Access assertion header', async () => {
    const clipId = await registerClip()
    const response = await uploadStills(clipId, stillsBody([jpegBytes(1)]), {})
    expect(response.status).toBe(403)
  })

  it('rejects a body with no stills, writing nothing', async () => {
    const clipId = await registerClip()
    const response = await uploadStills(clipId, new FormData())
    expect(response.status).toBe(400)
    await expect(storedKeys(clipId)).resolves.toBeNull()
  })

  it('rejects more stills than annotation will ever read', async () => {
    const clipId = await registerClip()
    const response = await uploadStills(clipId, stillsBody([1, 2, 3, 4].map(jpegBytes)))
    expect(response.status).toBe(400)
    await expect(storedKeys(clipId)).resolves.toBeNull()
  })

  it('rejects a part that is not a JPEG whatever its content type claims, writing nothing', async () => {
    const clipId = await registerClip()
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const response = await uploadStills(clipId, stillsBody([jpegBytes(1), png]))
    expect(response.status).toBe(400)
    await expect(storedKeys(clipId)).resolves.toBeNull()
    await expect(env.MEDIA.list({ prefix: `stills/${clipId}/` })).resolves.toMatchObject({ objects: [] })
  })

  it('rejects a request that is not multipart', async () => {
    const clipId = await registerClip()
    const response = await SELF.fetch(`https://vev.test/api/clips/${clipId}/stills`, {
      body: jpegBytes(1),
      headers: { 'content-type': 'image/jpeg', ...ACCESS_HEADERS },
      method: 'POST',
    })
    expect(response.status).toBe(400)
  })

  it('enqueues annotation at once, because registration only left a delayed message before any still existed', async () => {
    const clipId = await registerClip()
    const sent: unknown[] = []
    const queue = { send: async (body: unknown) => await Promise.resolve(sent.push(body)) }
    const ctx = createExecutionContext()

    const response = await worker.fetch(
      new Request(`https://vev.test/api/clips/${clipId}/stills`, {
        body: stillsBody([jpegBytes(1)]),
        headers: ACCESS_HEADERS,
        method: 'POST',
      }),
      { ...env, QUEUE_INGEST: queue },
      ctx,
    )
    await waitOnExecutionContext(ctx)

    expect(response.status).toBe(201)
    expect(sent).toStrictEqual([{ clipId, trigger: 'stills' }])
  })

  it('still records the stills when there is no queue binding', async () => {
    const clipId = await registerClip()
    const ctx = createExecutionContext()
    const response = await worker.fetch(
      new Request(`https://vev.test/api/clips/${clipId}/stills`, {
        body: stillsBody([jpegBytes(1)]),
        headers: ACCESS_HEADERS,
        method: 'POST',
      }),
      { ...env, QUEUE_INGEST: undefined },
      ctx,
    )
    await waitOnExecutionContext(ctx)
    expect(response.status).toBe(201)
    await expect(storedKeys(clipId)).resolves.toHaveLength(1)
  })
})
