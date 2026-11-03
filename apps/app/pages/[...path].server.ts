// SPDX-License-Identifier: AGPL-3.0-or-later
import { HTTPException } from 'hono/http-exception'
import { defineHandler } from 'void'

// Void has no app-level fallback for a path no page matches (`routing.notFound` only governs the
// asset layer), so this catch-all keeps the old SPA behaviour: a deep link, or a reload on a path the
// app no longer has, still loads the app instead of a bare Worker 404.
export const ssr = false

// A path that names a file is a missing asset, not an app route: answering it with the app shell
// would hand a browser HTML where it asked for a script or an image.
const FILE_PATH = /\/[^/]*\.[^/]*$/u

export const loader = defineHandler((c) => {
  const { pathname } = new URL(c.req.url)
  if (FILE_PATH.test(pathname)) {
    throw new HTTPException(404)
  }
  return { path: pathname }
})
