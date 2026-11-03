// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineMiddleware } from 'void'

import { server } from '../src/index.ts'

const SERVER_PATH = /^\/(?:api|media)\//u
const TRAILING_SLASH = /(?<=.)\/+$/u

export default defineMiddleware(async (c, next) => {
  const url = new URL(c.req.url)
  if (SERVER_PATH.test(url.pathname)) {
    return await server.fetch(c.req.raw, c.env, c.executionCtx)
  }
  // Pages match without the slash, and the catch-all would otherwise turn `/some-page/` into "Not found".
  if (TRAILING_SLASH.test(url.pathname)) {
    url.pathname = url.pathname.replace(TRAILING_SLASH, '')
    return c.redirect(url.toString(), 308)
  }
  await next()
})
