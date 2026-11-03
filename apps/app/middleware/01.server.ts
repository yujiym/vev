// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineMiddleware } from 'void'

import { server } from '../src/index.ts'

const SERVER_PATH = /^\/(?:api|media)\//u
const FILE_PATH = /\/[^/]*\.[^/]*$/u

export default defineMiddleware(async (c, next) => {
  const { origin, pathname } = new URL(c.req.url)
  if (SERVER_PATH.test(pathname)) {
    return await server.fetch(c.req.raw, c.env, c.executionCtx)
  }
  await next()
  // Void asks the assets again for a route's 404, so the SPA fallback cannot live in
  // the asset layer: it would answer an unknown /api path with 200 index.html.
  if (c.res.status === 404 && c.req.method === 'GET' && !FILE_PATH.test(pathname)) {
    c.res = await c.env.ASSETS.fetch(new Request(new URL('/', origin)))
  }
})
