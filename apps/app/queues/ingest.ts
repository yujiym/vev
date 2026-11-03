// SPDX-License-Identifier: AGPL-3.0-or-later
import { env } from 'cloudflare:workers'
import { defineQueue } from 'void'

import { ingestQueue } from '../src/ingest/consume.ts'
import type { IngestMessage } from '../src/ingest/consume.ts'

export const maxBatchSize = 1
export const maxRetries = 2

export default defineQueue<IngestMessage>(async (batch) => {
  await ingestQueue(batch, env)
})
