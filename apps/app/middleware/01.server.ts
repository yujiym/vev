// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineMiddleware } from 'void'

import { server } from '../src/index.ts'

const SERVER_PATH = /^\/(?:api|media)\//u

export default defineMiddleware(async (c, next) => {
  if (SERVER_PATH.test(new URL(c.req.url).pathname)) {
    return await server.fetch(c.req.raw, c.env, c.executionCtx)
  }
  await next()
})
