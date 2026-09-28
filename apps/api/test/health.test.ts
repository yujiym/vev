// SPDX-License-Identifier: AGPL-3.0-or-later
import { healthResponseSchema } from '@vev/shared'
import { env, SELF } from 'cloudflare:test'
import * as v from 'valibot'
import { describe, expect, it } from 'vitest'

describe('GET /api/health', () => {
  it('answers with a valid health response', async () => {
    const response = await SELF.fetch('https://vev.test/api/health')
    expect(response.status).toBe(200)
    const parsed = v.parse(healthResponseSchema, await response.json())
    expect(parsed.ok).toBe(true)
  })

  it('reports the mode from the environment', async () => {
    const response = await SELF.fetch('https://vev.test/api/health')
    const parsed = v.parse(healthResponseSchema, await response.json())
    expect(parsed.mode).toBe(env.VEV_MODE)
  })

  it('answers 404 for an unknown API route', async () => {
    const response = await SELF.fetch('https://vev.test/api/nope')
    expect(response.status).toBe(404)
  })

  it('counts the rows in the settings table', async () => {
    await env.DB.prepare("insert into settings (key, value) values ('probe', '1')").run()
    const response = await SELF.fetch('https://vev.test/api/health')
    const parsed = v.parse(healthResponseSchema, await response.json())
    expect(parsed.settingsRows).toBe(1)
  })
})
