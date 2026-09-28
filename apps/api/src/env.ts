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
  SOURCE_URL: string
  VEV_MODE: VevMode
  SETTINGS_ENCRYPTION_KEY?: string
  AI?: Ai
  VECTORIZE?: VectorizeIndex
}
