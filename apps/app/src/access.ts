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
 * and populated in `cloudflare.config.ts` for the day full JWT verification
 * (fetching and caching the team's JWKS, checking signature/iss/aud) lands;
 * that stretch did not land cleanly (no way to mint a real signed Access
 * JWT to test against, and Access's own edge redirect means `curl` never
 * reaches the Worker to exercise it live — see docs/runbook.md) so a
 * presence check is what ships.
 *
 * Disabled whenever `VEV_MODE` is 'local': local mode has no Cloudflare
 * Access by design (§15.3), and the Worker binds to loopback only, so there
 * is no Access assertion to check. `pnpm live` runs `--mode development`, so this
 * check is off there. The `apps/api` test pool's `VEV_MODE` is `'cloud'`,
 * NOT `'local'`, even though `vitest.config.ts` reads the
 * `'development'` configuration for D1/migrations — its `miniflare.bindings` overrides
 * `VEV_MODE` explicitly, the same way it overrides `GIT_COMMIT`. So this
 * check runs enabled in every `apps/api` test: an owner-route test needs a
 * real (non-blank) `Cf-Access-Jwt-Assertion` header or it 403s.
 *
 * Takes the public paths as an argument rather than relying on registration
 * order. Hono composes matched handlers (both `.use()` and route handlers)
 * in the order they were registered, so mounting this before `/health` and
 * trusting `/health`'s handler to never call `next()` would work — until a
 * route gets chained onto the `AppType`-producing const the same way
 * `/health` is (`app.get('/health', ...).post('/clips', ...)`), which
 * registers `/clips` ahead of a guard added afterwards and skips it
 * entirely. Mounting this FIRST, with an explicit skip set, keeps every
 * route added after it covered regardless of how it's chained.
 */
export const requireAccessAssertion =
  (publicPaths: ReadonlySet<string>): MiddlewareHandler<{ Bindings: Env }> =>
  async (c, next) => {
    if (publicPaths.has(c.req.path) || c.env.VEV_MODE === 'local') {
      await next()
      return
    }

    const assertion = c.req.header('Cf-Access-Jwt-Assertion')
    if (assertion === undefined || assertion.trim() === '') {
      return c.text('Forbidden', 403)
    }

    await next()
  }
