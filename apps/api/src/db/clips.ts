// SPDX-License-Identifier: AGPL-3.0-or-later
import type {
  AnnotationStatus,
  ClipDensity,
  ClipDeps,
  ClipEnergy,
  ClipGenerator,
  ClipLayerHint,
  ClipMotion,
  ClipOrigin,
  EngineKind,
} from '@vev/shared'
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

/**
 * A registered clip (spec §5 `Clip`). Arrays and nested objects live in JSON text columns —
 * SQLite has no array type, and `text({ mode: 'json' })` handles the (de)serialization.
 *
 * The library filters on `engine`, `reviewed` and `origin` (browsing by kind, by review state,
 * by provenance), so those three are indexed.
 */
export const clipsTable = sqliteTable(
  'clips',
  {
    annotationStatus: text('annotation_status').notNull().$type<AnnotationStatus>(),
    author: text('author').notNull(),
    code: text('code').notNull(),
    commercialOk: integer('commercial_ok', { mode: 'boolean' }).notNull(),
    defaultBars: integer('default_bars').notNull(),
    density: text('density').$type<ClipDensity>(),
    deps: text('deps', { mode: 'json' }).notNull().$type<ClipDeps>(),
    derivedFrom: text('derived_from', { mode: 'json' }).$type<string[]>(),
    description: text('description'),
    energy: integer('energy').$type<ClipEnergy>(),
    engine: text('engine').notNull().$type<EngineKind>(),
    generator: text('generator', { mode: 'json' }).$type<ClipGenerator>(),
    id: text('id').primaryKey(),
    isolated: integer('isolated', { mode: 'boolean' }).notNull(),
    layerHint: text('layer_hint').$type<ClipLayerHint>(),
    license: text('license').notNull(),
    modified: integer('modified', { mode: 'boolean' }).notNull(),
    motion: text('motion').$type<ClipMotion>(),
    origin: text('origin').notNull().$type<ClipOrigin>(),
    originalCode: text('original_code').notNull(),
    palette: text('palette', { mode: 'json' }).$type<string[]>(),
    params: text('params', { mode: 'json' }).notNull().$type<unknown[]>(),
    reviewed: integer('reviewed', { mode: 'boolean' }).notNull(),
    slug: text('slug').notNull().unique(),
    sourceUrl: text('source_url'),
    tags: text('tags', { mode: 'json' }).$type<string[]>(),
    thumbnailKey: text('thumbnail_key'),
    title: text('title').notNull(),
  },
  (table) => [
    index('clips_engine_idx').on(table.engine),
    index('clips_reviewed_idx').on(table.reviewed),
    index('clips_origin_idx').on(table.origin),
  ],
)
