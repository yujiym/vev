// SPDX-License-Identifier: AGPL-3.0-or-later
import { SELF } from 'cloudflare:test'
import { Hono } from 'hono'
import { describe, expect, it } from 'vitest'

import { requireAccessAssertion } from '../src/access.ts'
import type { Env } from '../src/env.ts'

const buildApp = (publicPaths: ReadonlySet<string> = new Set()) => {
  const app = new Hono<{ Bindings: Env }>()
  app.use('*', requireAccessAssertion(publicPaths))
  app.get('/owner-thing', (c) => c.text('ok'))
  return app
}

describe('requireAccessAssertion (unit, mounted standalone)', () => {
  const cloudEnv = {
    VEV_MODE: 'cloud',
  } as Env

  it('refuses a request with no assertion header', async () => {
    const response = await buildApp().request('/owner-thing', {}, cloudEnv)
    expect(response.status).toBe(403)
  })

  it('refuses a request with a blank assertion header', async () => {
    const response = await buildApp().request(
      '/owner-thing',
      { headers: { 'Cf-Access-Jwt-Assertion': '   ' } },
      cloudEnv,
    )
    expect(response.status).toBe(403)
  })

  it('passes a request carrying a non-blank assertion header', async () => {
    // The header value here is deliberately not a real JWT and not any
    // constant used elsewhere in the repo — this is a presence check, so
    // it must pass on this value precisely because it never inspects it.
    const response = await buildApp().request(
      '/owner-thing',
      { headers: { 'Cf-Access-Jwt-Assertion': 'zzz-not-a-real-jwt-zzz' } },
      cloudEnv,
    )
    expect(response.status).toBe(200)
  })

  it('is disabled in local mode, even with no header', async () => {
    const localEnv = { VEV_MODE: 'local' } as Env
    const response = await buildApp().request('/owner-thing', {}, localEnv)
    expect(response.status).toBe(200)
  })

  it('skips a path named in publicPaths, even with no header', async () => {
    const response = await buildApp(new Set(['/owner-thing'])).request('/owner-thing', {}, cloudEnv)
    expect(response.status).toBe(200)
  })
})

describe('requireAccessAssertion, wired into the real app', () => {
  it('refuses an unmatched /api/* route with no assertion header', async () => {
    const response = await SELF.fetch('https://vev.test/api/nope')
    expect(response.status).toBe(403)
  })

  it('leaves /api/health reachable with no assertion header', async () => {
    const response = await SELF.fetch('https://vev.test/api/health')
    expect(response.status).toBe(200)
  })
})
