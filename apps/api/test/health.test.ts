// SPDX-License-Identifier: AGPL-3.0-or-later
import { healthResponseSchema } from '@vev/shared'
import { env, SELF } from 'cloudflare:test'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'

describe('GET /api/health', () => {
  it('answers with a valid health response', async () => {
    // oxlint-disable-next-line typescript/no-deprecated -- 0.22.0 still ships SELF as the documented test entry point for fetching the main worker; the cloudflare:workers replacement requires Cloudflare.GlobalProps.mainModule typing this task does not add
    const response = await SELF.fetch('https://vev.test/api/health')
    expect(response.status).toBe(200)
    const parsed = v.parse(healthResponseSchema, await response.json())
    expect(parsed.ok).toBe(true)
  })

  it('reports the mode from the environment', async () => {
    // oxlint-disable-next-line typescript/no-deprecated -- see above
    const response = await SELF.fetch('https://vev.test/api/health')
    const parsed = v.parse(healthResponseSchema, await response.json())
    // oxlint-disable-next-line typescript/no-deprecated -- 0.22.0 still ships env as the documented way to read test bindings; the cloudflare:workers replacement requires Cloudflare.GlobalProps.mainModule typing this task does not add
    expect(parsed.mode).toBe(env.VEV_MODE)
  })

  it('answers 404 for an unknown API route', async () => {
    // oxlint-disable-next-line typescript/no-deprecated -- see above
    const response = await SELF.fetch('https://vev.test/api/nope')
    expect(response.status).toBe(404)
  })
})
