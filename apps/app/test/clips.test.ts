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

  it('refuses a two-output clip with a 400 telling the author what to change, and stores nothing', async () => {
    const response = await postClip({
      ...minimalPayload(),
      code: 'osc(10).out(o1)\nnoise(3).out(o2)',
      title: 'two outputs',
    })
    expect(response.status).toBe(400)
    await expect(response.text()).resolves.toMatch(/single .out\(/u)
    const row = await env.DB.prepare('select count(*) as n from clips where title = ?')
      .bind('two outputs')
      .first<{ n: number }>()
    expect(row?.n).toBe(0)
  })

  it('refuses two bare .out() calls too — neither names a buffer, and the clip still writes twice', async () => {
    const response = await postClip({ ...minimalPayload(), code: 'osc(10).out()\nnoise(3).out()' })
    expect(response.status).toBe(400)
  })

  it('refuses a two-output clip whatever engine it claims — the renderer makes no such distinction', async () => {
    // `output-client.ts`'s `onLoad` hands any clip's code to `HydraCompositor.load` with no
    // engine branch, so an isf-labelled clip with two `.out(` calls writes another slot's buffer
    // exactly as a hydra one would. The gate must not trust a field its consumer ignores.
    const response = await postClip({
      ...minimalPayload(),
      code: 'osc(10).out(o1)\nnoise(3).out(o2)',
      engine: 'isf',
      title: 'two outputs, isf',
    })
    expect(response.status).toBe(400)
    await expect(response.text()).resolves.toMatch(/single .out\(/u)
    const row = await env.DB.prepare('select count(*) as n from clips where title = ?')
      .bind('two outputs, isf')
      .first<{ n: number }>()
    expect(row?.n).toBe(0)
  })

  it('still registers a single-output non-hydra clip, which the gate must not touch', async () => {
    const response = await postClip({ ...minimalPayload(), code: 'osc(10).out()', engine: 'textmode' })
    expect(response.status).toBe(201)
    const body = await readJson<{ deps: { outputsUsed: string[] }; isolated: boolean }>(response)
    // Dependency analysis is still Hydra-only (§11.1): a non-hydra clip gets the empty baseline
    // rather than a guess, and is never isolated by inference.
    expect(body.deps.outputsUsed).toStrictEqual([])
    expect(body.isolated).toBe(false)
  })

  it('counts .out( with the probe scanner, so a commented-out call is not stored as a used output', async () => {
    const response = await postClip({
      ...minimalPayload(),
      code: '// noise().out(o2)\nosc(10).out(o1)',
    })
    expect(response.status).toBe(201)
    const body = await readJson<{ deps: { outputsUsed: string[] }; isolated: boolean }>(response)
    expect(body.deps.outputsUsed).toStrictEqual(['o1'])
    expect(body.isolated).toBe(false)
  })

  it('refuses a request with no Access assertion header', async () => {
    const response = await postClip(minimalPayload(), {})
    expect(response.status).toBe(403)
  })

  it('refuses a colliding client-supplied slug with a 409 naming it, not an opaque 500', async () => {
    const first = await postClip({ ...minimalPayload(), slug: 'hydra/already-taken' })
    expect(first.status).toBe(201)

    const second = await postClip({ ...minimalPayload(), slug: 'hydra/already-taken' })
    expect(second.status).toBe(409)
    await expect(second.text()).resolves.toContain('hydra/already-taken')
  })

  it('leaves a generated slug alone — the collision path must not fire on the ordinary case', async () => {
    const response = await postClip(minimalPayload())
    expect(response.status).toBe(201)
    const body = await readJson<{ slug: string }>(response)
    expect(body.slug).toMatch(/^hydra\/aquatic-blubs-/u)
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

  it('treats a tag filter as a literal tag, not a LIKE pattern: "%" matches no tag called "%"', async () => {
    const created = await postClip({ ...minimalPayload(), title: 'wildcard bait' })
    const { id } = await readJson<{ id: string }>(created)
    await env.DB.prepare('update clips set tags = ? where id = ?')
      .bind(JSON.stringify(['neon', 'dark']), id)
      .run()

    const response = await SELF.fetch('https://vev.test/api/clips?tag=%25', { headers: ACCESS_HEADERS })
    expect(response.status).toBe(200)
    const body = await readJson<{ clips: ClipSummary[] }>(response)
    expect(body.clips.map((clip) => clip.id)).not.toContain(id)
  })

  it('does not let "_" stand in for a character: "_eon" must not match "neon"', async () => {
    const created = await postClip({ ...minimalPayload(), title: 'underscore bait' })
    const { id } = await readJson<{ id: string }>(created)
    await env.DB.prepare('update clips set tags = ? where id = ?')
      .bind(JSON.stringify(['neon']), id)
      .run()

    const response = await SELF.fetch('https://vev.test/api/clips?tag=_eon', { headers: ACCESS_HEADERS })
    const body = await readJson<{ clips: ClipSummary[] }>(response)
    expect(body.clips.map((clip) => clip.id)).not.toContain(id)
  })

  it('matches a tag that itself contains a "%" — a literal per cent is a legitimate tag', async () => {
    const created = await postClip({ ...minimalPayload(), title: 'per cent tag' })
    const { id } = await readJson<{ id: string }>(created)
    await env.DB.prepare('update clips set tags = ? where id = ?')
      .bind(JSON.stringify(['100%']), id)
      .run()

    const response = await SELF.fetch(`https://vev.test/api/clips?tag=${encodeURIComponent('100%')}`, {
      headers: ACCESS_HEADERS,
    })
    const body = await readJson<{ clips: ClipSummary[] }>(response)
    expect(body.clips.map((clip) => clip.id)).toContain(id)
  })

  it('matches a tag exactly, not as a substring of a longer one', async () => {
    const created = await postClip({ ...minimalPayload(), title: 'substring bait' })
    const { id } = await readJson<{ id: string }>(created)
    await env.DB.prepare('update clips set tags = ? where id = ?')
      .bind(JSON.stringify(['kaleidoscope']), id)
      .run()

    const response = await SELF.fetch('https://vev.test/api/clips?tag=kaleid', { headers: ACCESS_HEADERS })
    const body = await readJson<{ clips: ClipSummary[] }>(response)
    expect(body.clips.map((clip) => clip.id)).not.toContain(id)
  })

  it('answers a tag filter without error for a clip whose tags column is still NULL', async () => {
    const created = await postClip(minimalPayload())
    expect(created.status).toBe(201)

    const response = await SELF.fetch('https://vev.test/api/clips?tag=neon', { headers: ACCESS_HEADERS })
    expect(response.status).toBe(200)
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
    // Every clip the route now accepts is computed `isolated: false` — a multi-output one is
    // refused at POST — so the value a patch must not be able to invent is `true`.
    const created = await postClip(minimalPayload())
    const { id } = await readJson<{ id: string }>(created)
    const response = await patchClip(id, { isolated: true })
    expect(response.status).toBe(400)
    const row = await env.DB.prepare('select isolated from clips where id = ?').bind(id).first()
    expect(row?.isolated).toBe(0)
  })

  it('cannot change id, origin or deps', async () => {
    const created = await postClip(minimalPayload())
    const { id } = await readJson<{ id: string }>(created)
    const response = await patchClip(id, { deps: { extensions: [] }, id: 'new-id', origin: 'authored' })
    expect(response.status).toBe(400)
  })

  it('answers an empty patch with the unchanged clip, the way PATCH /api/tracks/:id does', async () => {
    const created = await postClip(minimalPayload())
    const { id, title } = await readJson<{ id: string; title: string }>(created)

    const response = await patchClip(id, {})
    expect(response.status).toBe(200)
    const body = await readJson<{ title: string }>(response)
    expect(body.title).toBe(title)
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
