// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it } from 'vitest'

import { targets } from '../deploy-targets.ts'

describe('deploy targets', () => {
  // Cloudflare Access protects only the custom domain (§13). Void defaults both flags to true, so
  // a cloud target that leaves either unset is reachable on a workers.dev URL with no Access in
  // front of it, and the Worker's own guard only checks that an assertion header is present.
  it.each(['preview', 'production'] as const)('%s closes both workers.dev paths', (name) => {
    expect(targets[name]).toMatchObject({ preview_urls: false, workers_dev: false })
  })

  it.each(['preview', 'production'] as const)('%s keeps its logs', (name) => {
    expect(targets[name].observability).toStrictEqual({ enabled: true })
  })

  // With Version URLs closed, Void has no other way to check a version before activating it.
  it.each(['preview', 'production'] as const)('%s can pass the readiness check', (name) => {
    expect(targets[name].version_metadata).toBeDefined()
  })
})
