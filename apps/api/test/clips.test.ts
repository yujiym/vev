// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ClipSummary } from '@vev/shared'
import { env, SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const ACCESS_HEADERS = { 'Cf-Access-Jwt-Assertion': 'zzz-not-a-real-jwt-zzz' }
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu

const minimalPayload = () => ({
  author: 'Khoparzi',
  code: 'osc(10, 0.1, 1.2).kaleid(4).out()',
  engine: 'hydra',
  license: 'CC BY 4.0',
  title: 'Aquatic blubs',
})

const postClip = async (body: unknown, headers: Record<string, string> = ACCESS_HEADERS) =>
  await SELF.fetch('https://vev.test/api/clips', {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
    method: 'POST',
  })

const readJson = async <T>(response: Response): Promise<T> =>
  // SAFETY: every call site below names the exact shape this suite's own route just produced —
  // asserting it here just gives the test body a typed value to read fields off of.
  await response.json()

describe('POST /api/clips', () => {
  it('registers a minimal valid clip and returns 201 with a server-generated id', async () => {
    const response = await postClip(minimalPayload())
    expect(response.status).toBe(201)
    const body = await readJson<{ id: string }>(response)
    expect(body.id).toMatch(UUID_RE)
  })

  it('stores the row in D1 with annotationStatus pending', async () => {
    const response = await postClip(minimalPayload())
    const body = await readJson<{ id: string }>(response)
    const row = await env.DB.prepare('select * from clips where id = ?').bind(body.id).first()
    expect(row?.annotation_status).toBe('pending')
  })

  it('rejects a client-supplied id rather than silently ignoring it', async () => {
    const response = await postClip({ ...minimalPayload(), id: 'client-chosen-id' })
    expect(response.status).toBe(400)
  })

  it('rejects an empty license', async () => {
    const response = await postClip({ ...minimalPayload(), license: '' })
    expect(response.status).toBe(400)
  })

  it('accepts license "unknown" and forces commercialOk to false', async () => {
    const response = await postClip({ ...minimalPayload(), license: 'unknown' })
    expect(response.status).toBe(201)
    const body = await readJson<{ commercialOk: boolean }>(response)
    expect(body.commercialOk).toBe(false)
  })

  it('rejects license "unknown" paired with commercialOk: true (§14.2)', async () => {
    const response = await postClip({ ...minimalPayload(), commercialOk: true, license: 'unknown' })
    expect(response.status).toBe(400)
  })

  it('computes deps and isolated from the code, marking a two-output clip isolated', async () => {
    const response = await postClip({
      ...minimalPayload(),
      code: 'osc(10).out(o1)\nnoise(3).out(o2)',
    })
    expect(response.status).toBe(201)
    const body = await readJson<{ id: string }>(response)
    const row = await env.DB.prepare('select isolated from clips where id = ?').bind(body.id).first()
    expect(row?.isolated).toBe(1)
  })

  it('refuses a request with no Access assertion header', async () => {
    const response = await postClip(minimalPayload(), {})
    expect(response.status).toBe(403)
  })
})

describe('GET /api/clips', () => {
  it('returns clip summaries, not whole clip rows', async () => {
    await postClip(minimalPayload())
    const response = await SELF.fetch('https://vev.test/api/clips', { headers: ACCESS_HEADERS })
    expect(response.status).toBe(200)
    const body = await readJson<{ clips: ClipSummary[] }>(response)
    expect(body.clips[0]).not.toHaveProperty('code')
  })

  it('filters by engine, excluding a non-matching clip and keeping a matching one', async () => {
    await postClip(minimalPayload())
    const excluded = await SELF.fetch('https://vev.test/api/clips?engine=isf', {
      headers: ACCESS_HEADERS,
    })
    const excludedBody = await readJson<{ clips: ClipSummary[] }>(excluded)
    expect(excludedBody.clips).toHaveLength(0)

    const included = await SELF.fetch('https://vev.test/api/clips?engine=hydra', {
      headers: ACCESS_HEADERS,
    })
    const includedBody = await readJson<{ clips: ClipSummary[] }>(included)
    expect(includedBody.clips[0]?.engine).toBe('hydra')
  })

  it('rejects an unparseable engine filter with a 400 naming the parameter', async () => {
    const response = await SELF.fetch('https://vev.test/api/clips?engine=hydraa', {
      headers: ACCESS_HEADERS,
    })
    expect(response.status).toBe(400)
    const text = await response.text()
    expect(text).toContain('engine')
  })

  it('treats an absent engine filter as no filter, not an error', async () => {
    await postClip(minimalPayload())
    const response = await SELF.fetch('https://vev.test/api/clips', { headers: ACCESS_HEADERS })
    expect(response.status).toBe(200)
  })

  it('filters by reviewed, excluding a reviewed=true clip and keeping the unreviewed default', async () => {
    await postClip(minimalPayload())
    const excluded = await SELF.fetch('https://vev.test/api/clips?reviewed=true', {
      headers: ACCESS_HEADERS,
    })
    const excludedBody = await readJson<{ clips: ClipSummary[] }>(excluded)
    expect(excludedBody.clips).toHaveLength(0)

    const included = await SELF.fetch('https://vev.test/api/clips?reviewed=false', {
      headers: ACCESS_HEADERS,
    })
    const includedBody = await readJson<{ clips: ClipSummary[] }>(included)
    expect(includedBody.clips.every((clip) => !clip.reviewed)).toBe(true)
    expect(includedBody.clips.length).toBeGreaterThan(0)
  })

  it('rejects an unparseable reviewed filter with a 400 naming the parameter, rather than quietly meaning false', async () => {
    const response = await SELF.fetch('https://vev.test/api/clips?reviewed=banana', {
      headers: ACCESS_HEADERS,
    })
    expect(response.status).toBe(400)
    const text = await response.text()
    expect(text).toContain('reviewed')
  })

  it('treats an absent reviewed filter as no filter, not an error', async () => {
    await postClip(minimalPayload())
    const response = await SELF.fetch('https://vev.test/api/clips', { headers: ACCESS_HEADERS })
    expect(response.status).toBe(200)
  })

  it('filters by tag, matching a clip carrying it and excluding one that does not', async () => {
    const created = await postClip(minimalPayload())
    const { id } = await readJson<{ id: string }>(created)
    await env.DB.prepare('update clips set tags = ? where id = ?')
      .bind(JSON.stringify(['kaleid']), id)
      .run()

    const excluded = await SELF.fetch('https://vev.test/api/clips?tag=nonexistent-tag', {
      headers: ACCESS_HEADERS,
    })
    const excludedBody = await readJson<{ clips: ClipSummary[] }>(excluded)
    expect(excludedBody.clips).toHaveLength(0)

    const included = await SELF.fetch('https://vev.test/api/clips?tag=kaleid', {
      headers: ACCESS_HEADERS,
    })
    const includedBody = await readJson<{ clips: ClipSummary[] }>(included)
    expect(includedBody.clips).toHaveLength(1)
  })

  it('refuses a request with no Access assertion header', async () => {
    const response = await SELF.fetch('https://vev.test/api/clips')
    expect(response.status).toBe(403)
  })
})

describe('GET /api/clips/:id', () => {
  it('returns the full clip for a known id', async () => {
    const created = await postClip(minimalPayload())
    const { id } = await readJson<{ id: string }>(created)
    const response = await SELF.fetch(`https://vev.test/api/clips/${id}`, { headers: ACCESS_HEADERS })
    expect(response.status).toBe(200)
    const body = await readJson<{ code: string }>(response)
    expect(body.code).toBe('osc(10, 0.1, 1.2).kaleid(4).out()')
  })

  it('answers 404 for an unknown id', async () => {
    const response = await SELF.fetch('https://vev.test/api/clips/does-not-exist', {
      headers: ACCESS_HEADERS,
    })
    expect(response.status).toBe(404)
  })

  it('refuses a request with no Access assertion header', async () => {
    const created = await postClip(minimalPayload())
    const { id } = await readJson<{ id: string }>(created)
    const response = await SELF.fetch(`https://vev.test/api/clips/${id}`)
    expect(response.status).toBe(403)
  })
})

const patchClip = async (id: string, body: unknown, headers: Record<string, string> = ACCESS_HEADERS) =>
  await SELF.fetch(`https://vev.test/api/clips/${id}`, {
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
    method: 'PATCH',
  })

describe('PATCH /api/clips/:id', () => {
  it('edits a human-editable annotation field and persists it', async () => {
    const created = await postClip(minimalPayload())
    const { id } = await readJson<{ id: string }>(created)
    const response = await patchClip(id, { description: 'a distinct patched description' })
    expect(response.status).toBe(200)
    const row = await env.DB.prepare('select description from clips where id = ?').bind(id).first()
    expect(row?.description).toBe('a distinct patched description')
  })

  it('cannot change isolated, and the stored row keeps its computed value', async () => {
    const created = await postClip({
      ...minimalPayload(),
      code: 'osc(10).out(o1)\nnoise(3).out(o2)',
    })
    const { id } = await readJson<{ id: string }>(created)
    const response = await patchClip(id, { isolated: false })
    expect(response.status).toBe(400)
    const row = await env.DB.prepare('select isolated from clips where id = ?').bind(id).first()
    expect(row?.isolated).toBe(1)
  })

  it('cannot change id, origin or deps', async () => {
    const created = await postClip(minimalPayload())
    const { id } = await readJson<{ id: string }>(created)
    const response = await patchClip(id, { deps: { extensions: [] }, id: 'new-id', origin: 'authored' })
    expect(response.status).toBe(400)
  })

  it('answers 404 for an unknown id', async () => {
    const response = await patchClip('does-not-exist', { description: 'x' })
    expect(response.status).toBe(404)
  })

  it('refuses a request with no Access assertion header', async () => {
    const created = await postClip(minimalPayload())
    const { id } = await readJson<{ id: string }>(created)
    const response = await patchClip(id, { description: 'x' }, {})
    expect(response.status).toBe(403)
  })
})
