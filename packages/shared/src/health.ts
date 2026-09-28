// SPDX-License-Identifier: AGPL-3.0-or-later
import * as v from 'valibot'

/** The two runtimes vev has: a deployed Worker, and local mode at a venue (§15.3). */
export const vevModeSchema = v.picklist(['cloud', 'local'])

/** `GET /api/health` — the one route M0 ships, and the smoke test for every later milestone. */
export const healthResponseSchema = v.object({
  /** Short git commit of the running build; `dev` outside a release build. */
  commit: v.pipe(v.string(), v.minLength(1)),
  mode: vevModeSchema,
  ok: v.boolean(),
  /** Row count of the `settings` table: proves D1 and the migrations are live. */
  settingsRows: v.pipe(v.number(), v.integer(), v.minValue(0)),
})

export type VevMode = v.InferOutput<typeof vevModeSchema>
export type HealthResponse = v.InferOutput<typeof healthResponseSchema>
