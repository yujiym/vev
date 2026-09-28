// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ProbeResult } from '@vev/engines/hydra'
import type { Clip } from '@vev/shared'
import { describe, expect, it, vi } from 'vitest'

import type { ClipFormInput, ProbeFn } from './register-clip.ts'
import {
  applyPrefill,
  buildNewClip,
  prefillFromCode,
  runProbe,
  submitClip,
  submitThumbnail,
} from './register-clip.ts'

const HEADER_CODE =
  '// @author Khoparzi\n// license: CC BY 4.0\n// source: https://hydra.ojack.xyz/?sketch=1\nosc(10).out()'
const HEADERLESS_CODE = 'osc(10, 0.1, 1.2).kaleid(4).out()'

const minimalForm = (): ClipFormInput => ({
  author: 'Khoparzi',
  code: 'osc(10).out()',
  commercialOk: false,
  engine: 'hydra',
  license: 'CC BY 4.0',
  modified: false,
  origin: 'imported',
  title: 'Aquatic blubs',
})

describe(prefillFromCode, () => {
  it('pre-fills author, license and sourceUrl from a header comment', () => {
    const prefill = prefillFromCode(HEADER_CODE)
    expect(prefill).toStrictEqual({
      author: 'Khoparzi',
      license: 'CC BY 4.0',
      sourceUrl: 'https://hydra.ojack.xyz/?sketch=1',
    })
  })

  it('defaults license to "unknown" — never invented — and author to empty for headerless code', () => {
    const prefill = prefillFromCode(HEADERLESS_CODE)
    expect(prefill).toStrictEqual({ author: '', license: 'unknown', sourceUrl: undefined })
  })
})

describe(applyPrefill, () => {
  it('fills in every field that is still empty', () => {
    const result = applyPrefill(
      { author: '', license: '', sourceUrl: '' },
      { author: 'Khoparzi', license: 'CC BY 4.0', sourceUrl: 'https://hydra.ojack.xyz/?sketch=1' },
    )
    expect(result).toStrictEqual({
      author: 'Khoparzi',
      license: 'CC BY 4.0',
      sourceUrl: 'https://hydra.ojack.xyz/?sketch=1',
    })
  })

  it('leaves fields the registrant already typed untouched, even when the prefill disagrees', () => {
    const result = applyPrefill(
      { author: 'A human typed this', license: 'MIT', sourceUrl: 'https://example.test/mine' },
      { author: 'Khoparzi', license: 'CC BY 4.0', sourceUrl: 'https://hydra.ojack.xyz/?sketch=1' },
    )
    expect(result).toStrictEqual({
      author: 'A human typed this',
      license: 'MIT',
      sourceUrl: 'https://example.test/mine',
    })
  })

  it('leaves sourceUrl empty when the prefill found none, rather than writing "undefined"', () => {
    const result = applyPrefill(
      { author: '', license: '', sourceUrl: '' },
      { author: '', license: 'unknown' },
    )
    expect(result.sourceUrl).toBe('')
  })

  it('fills in only the empty fields when some are already typed', () => {
    const result = applyPrefill(
      { author: '', license: 'GPL-3.0', sourceUrl: '' },
      { author: 'Khoparzi', license: 'CC BY 4.0', sourceUrl: 'https://hydra.ojack.xyz/?sketch=1' },
    )
    expect(result).toStrictEqual({
      author: 'Khoparzi',
      license: 'GPL-3.0',
      sourceUrl: 'https://hydra.ojack.xyz/?sketch=1',
    })
  })
})

describe(buildNewClip, () => {
  it('builds a payload matching newClipSchema from a valid form', () => {
    const clip = buildNewClip({
      ...minimalForm(),
      commercialOk: true,
      license: 'CC0',
      modified: true,
      origin: 'authored',
      slug: 'hydra/aquatic-blubs',
      sourceUrl: 'https://example.test/sketch',
    })

    expect(clip).toStrictEqual({
      author: 'Khoparzi',
      code: 'osc(10).out()',
      commercialOk: true,
      defaultBars: 8,
      engine: 'hydra',
      license: 'CC0',
      modified: true,
      origin: 'authored',
      slug: 'hydra/aquatic-blubs',
      sourceUrl: 'https://example.test/sketch',
      title: 'Aquatic blubs',
    })
  })

  it('leaves slug and sourceUrl undefined when the form left them unset', () => {
    const clip = buildNewClip(minimalForm())
    expect(clip.slug).toBeUndefined()
    expect(clip.sourceUrl).toBeUndefined()
  })

  it('rejects an empty title rather than sending it to the server', () => {
    expect(() => buildNewClip({ ...minimalForm(), title: '' })).toThrow(/./u)
  })

  it('rejects license "unknown" paired with commercialOk: true, client-side (§14.2)', () => {
    expect(() => buildNewClip({ ...minimalForm(), commercialOk: true, license: 'unknown' })).toThrow(
      /commercialOk to false/u,
    )
  })
})

describe(runProbe, () => {
  it('forwards to the injected probe function with the same code and canvas', async () => {
    const canvas = {} as HTMLCanvasElement
    const result: ProbeResult = { maxFrameMs: 3, ok: true }
    const probe = vi.fn<ProbeFn>().mockResolvedValue(result)

    const outcome = await runProbe('osc(10).out()', canvas, probe)

    expect(probe).toHaveBeenCalledWith('osc(10).out()', canvas)
    expect(outcome).toBe(result)
  })
})

const jsonResponse = (body: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    json: async () => await Promise.resolve(body),
    ok,
    status,
  }) as unknown as Response

describe(submitClip, () => {
  it('POSTs the payload and returns the parsed row on success', async () => {
    const row: Clip = {
      annotationStatus: 'pending',
      author: 'Khoparzi',
      code: 'osc(10).out()',
      commercialOk: false,
      defaultBars: 8,
      deps: { extensions: [], outputsUsed: [], sourcesUsed: [], usesAudio: false, usesFeedback: false },
      engine: 'hydra',
      id: 'a1b2c3d4-0000-0000-0000-000000000000',
      isolated: false,
      license: 'CC BY 4.0',
      modified: false,
      origin: 'imported',
      originalCode: 'osc(10).out()',
      params: [],
      reviewed: false,
      slug: 'hydra/aquatic-blubs-a1b2c3d4',
      title: 'Aquatic blubs',
    }
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse(row))

    const returned = await submitClip(buildNewClip(minimalForm()), fetchImpl)

    expect(returned).toStrictEqual(row)
    expect(fetchImpl).toHaveBeenCalledWith('/api/clips', expect.objectContaining({ method: 'POST' }))
  })

  it('throws with the status when the server rejects the request', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, false, 400))

    await expect(submitClip(buildNewClip(minimalForm()), fetchImpl)).rejects.toThrow('400')
  })
})

describe(submitThumbnail, () => {
  it('POSTs the blob to the clip-scoped endpoint and returns the stored key', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(jsonResponse({ thumbnailKey: 'thumbnails/some-id.webm' }))
    const blob = new Blob(['fake webm bytes'], { type: 'video/webm' })

    const result = await submitThumbnail('some-id', blob, fetchImpl)

    expect(result).toStrictEqual({ thumbnailKey: 'thumbnails/some-id.webm' })
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/clips/some-id/thumbnail',
      expect.objectContaining({ body: blob, method: 'POST' }),
    )
  })

  it('throws with the status when the upload fails', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(jsonResponse({}, false, 404))
    const blob = new Blob(['x'], { type: 'video/webm' })

    await expect(submitThumbnail('missing-id', blob, fetchImpl)).rejects.toThrow('404')
  })
})
