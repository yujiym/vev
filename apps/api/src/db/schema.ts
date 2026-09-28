// SPDX-License-Identifier: AGPL-3.0-or-later
import { sqliteTable, text } from 'drizzle-orm/sqlite-core'

/** Owner-level settings (§8.4 stores the decision-provider chain here). */
export const settingsTable = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
