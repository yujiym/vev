// SPDX-License-Identifier: AGPL-3.0-or-later
import type { VevMode } from '@vev/shared'

/**
 * The Worker's binding surface.
 *
 * The cloud-only bindings are OPTIONAL on purpose: local mode (§15.3) runs the
 * same artifact with no Workers AI, no Vectorize and no queue, so every route
 * has to work with them absent. Optional here makes that a compile-time rule
 * instead of a convention.
 */
export interface Env {
  DB: D1Database
  /** Cloudflare Access application audience tag (§13). Not read when VEV_MODE is 'local'. */
  ACCESS_AUD: string
  /** Cloudflare Access team domain, e.g. `<team>.cloudflareaccess.com` (§13). Not read when VEV_MODE is 'local'. */
  ACCESS_TEAM_DOMAIN: string
  /** Short git commit of the running build, injected at build time (§14.1). */
  GIT_COMMIT: string
  SOURCE_URL: string
  VEV_MODE: VevMode
  SETTINGS_ENCRYPTION_KEY?: string
  AI?: Ai
  VECTORIZE?: VectorizeIndex
  /** Clip thumbnails and source media (Task 4+). Required — R2 has a local implementation in miniflare. */
  MEDIA: R2Bucket
  /** Annotation ingest queue (Task 5). Optional like AI/VECTORIZE — a queue is pointless offline (§15.3). */
  INGEST?: Queue
}
