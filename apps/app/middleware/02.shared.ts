// SPDX-License-Identifier: AGPL-3.0-or-later
import * as v from 'valibot'
import { defineMiddleware } from 'void'

// The AGPL §13 source offer (§14.1) is rendered by the layout on every page, so it travels as shared
// page data. It comes from the Worker's own vars: the commit is the one this build was made from, and
// `/api/health` reports the same value.
declare module 'void' {
  interface CloudContextVariables {
    shared: { commit: string; sourceUrl: string }
  }
}

// Void types `c.env` as an open record, so the two vars are parsed at this boundary rather than cast.
const sourceVarsSchema = v.object({ GIT_COMMIT: v.string(), SOURCE_URL: v.string() })

export default defineMiddleware(async (c, next) => {
  const { GIT_COMMIT, SOURCE_URL } = v.parse(sourceVarsSchema, c.env)
  c.set('shared', { commit: GIT_COMMIT, sourceUrl: SOURCE_URL })
  await next()
})
