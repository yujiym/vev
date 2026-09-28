// SPDX-License-Identifier: AGPL-3.0-or-later
import adapter from '@sveltejs/adapter-static'

/** @type {import('@sveltejs/kit').Config} */
const config = {
  compilerOptions: { runes: true },
  kit: {
    // SPA: one index.html fallback, served by the Worker's assets binding with
    // not_found_handling = "single-page-application" (§3, §4.1).
    adapter: adapter({ assets: 'build', fallback: 'index.html', pages: 'build', precompress: false }),
  },
}

export default config
