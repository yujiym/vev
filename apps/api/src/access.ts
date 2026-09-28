// SPDX-License-Identifier: AGPL-3.0-or-later
import type { MiddlewareHandler } from 'hono'

import type { Env } from './env.ts'

/**
 * §13 defence in depth: Cloudflare Access has already authenticated the
 * request by the time it reaches the Worker, so this exists only to catch
 * Access being *misconfigured off* on a protected hostname — not to
 * authenticate on its own.
 *
 * This is a PRESENCE check, not a verification: it confirms
 * `Cf-Access-Jwt-Assertion` was set by Access and refuses the request
 * (403) when it is missing or blank. It does not decode the token, and it
 * does not check its signature, issuer, audience or expiry against
 * `ACCESS_TEAM_DOMAIN` / `ACCESS_AUD` — those vars are declared on `Env`
 * and populated in `wrangler.jsonc` for the day full JWT verification
 * (fetching and caching the team's JWKS, checking signature/iss/aud) lands;
 * that stretch did not land cleanly (no way to mint a real signed Access
 * JWT to test against, and Access's own edge redirect means `curl` never
 * reaches the Worker to exercise it live — see docs/runbook.md) so a
 * presence check is what ships.
 *
 * Disabled whenever `VEV_MODE` is 'local': local mode has no Cloudflare
 * Access by design (§15.3), and the Worker binds to loopback only, so there
 * is no Access assertion to check. `pnpm live` runs `--env local`, so this
 * check is off there. The `apps/api` test pool's `VEV_MODE` is `'cloud'`,
 * NOT `'local'`, even though `vite.config.ts` points `wrangler.environment`
 * at `'local'` for D1/migrations — its `miniflare.bindings` overrides
 * `VEV_MODE` explicitly, the same way it overrides `GIT_COMMIT`. So this
 * check runs enabled in every `apps/api` test: an owner-route test needs a
 * real (non-blank) `Cf-Access-Jwt-Assertion` header or it 403s.
 */
export const requireAccessAssertion: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  if (c.env.VEV_MODE === 'local') {
    await next()
    return
  }

  const assertion = c.req.header('Cf-Access-Jwt-Assertion')
  if (assertion === undefined || assertion.trim() === '') {
    return c.text('Forbidden', 403)
  }

  await next()
}
