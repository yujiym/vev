// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Track, TransitionSpec } from '@vev/shared'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

import { clipsTable } from './clips.ts'

/** A saved, playable sequence of clips (spec §5 `Track`). */
export const tracksTable = sqliteTable('tracks', {
  bpmDefault: integer('bpm_default'),
  defaultTransition: text('default_transition', { mode: 'json' }).notNull().$type<TransitionSpec>(),
  id: text('id').primaryKey(),
  mode: text('mode').notNull().$type<Track['mode']>(),
  ownerId: text('owner_id').notNull(),
  slug: text('slug').notNull().unique(),
  title: text('title').notNull(),
  visibility: text('visibility').notNull().$type<Track['visibility']>(),
})

/**
 * A track's ordered clips (spec §5 `TrackItem`), one row per item rather than a JSON blob on
 * `tracks`: the editor reorders rows by `position`, and M6 adds per-item transition settings to
 * this table.
 */
export const trackItemsTable = sqliteTable('track_items', {
  bars: integer('bars'),
  clipId: text('clip_id')
    .notNull()
    .references(() => clipsTable.id),
  id: text('id').primaryKey(),
  position: integer('position').notNull(),
  section: text('section'),
  trackId: text('track_id')
    .notNull()
    .references(() => tracksTable.id),
  transitionIn: text('transition_in', { mode: 'json' }).$type<TransitionSpec>(),
})
