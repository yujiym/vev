// SPDX-License-Identifier: AGPL-3.0-or-later
import { bindings, defineConfig, triggers } from 'cf/config'

export default defineConfig(({ mode }) => {
  const local = mode === 'development'
  const preview = mode === 'preview'
  const cloudDatabaseId = preview
    ? 'bcee626b-7dbd-4456-8fb9-a708583e6e1d'
    : '00000000-0000-0000-0000-000000000000'
  const resourceSuffix = preview ? '-preview' : ''

  const env = {
    // The audience still needs dashboard confirmation; see the runbook.
    ACCESS_AUD: bindings.text(
      local ? 'unused-in-local-mode' : '2751fc6207bcfd7f632e739f25ffd5a12a8325b4fcd8825fb9cbeac9bdf01ffd',
    ),
    ACCESS_TEAM_DOMAIN: bindings.text(local ? 'unused-in-local-mode' : '710gs.cloudflareaccess.com'),
    DB: bindings.d1({
      // Local has its own UUID; production's real ID is still pending M12.
      id: local ? '9b91c754-01f5-4399-98a7-bc8b5c9e65e8' : cloudDatabaseId,
      name: `vev${resourceSuffix}`,
    }),
    GIT_COMMIT: bindings.text(process.env.GIT_COMMIT ?? 'dev'),
    MEDIA: bindings.r2({ name: `vev-media${resourceSuffix}` }),
    SOURCE_URL: bindings.text('https://github.com/yujiym/vev'),
    VEV_MODE: bindings.text(local ? 'local' : 'cloud'),
  }

  return {
    worker: {
      // Both routes must reach the Worker before the SPA fallback.
      assets: {
        notFoundHandling: 'single-page-application',
        runWorkerFirst: ['/api/*', '/media/*'],
      },
      compatibilityDate: '2026-09-01',
      compatibilityFlags: ['nodejs_compat'],
      // Access protects only the custom domain. Keep both workers.dev paths closed.
      domains: preview ? ['vev-preview.0x7.sh'] : undefined,
      entrypoint: 'src/index.ts',
      env: local
        ? env
        : {
            ...env,
            AI: bindings.ai(),
            INGEST: bindings.queue({ name: `vev-ingest${resourceSuffix}` }),
          },
      name: local ? 'vev-local' : `vev${resourceSuffix}`,
      previewUrls: preview ? false : undefined,
      triggers: local
        ? []
        : [triggers.queue({ maxBatchSize: 1, maxRetries: 2, name: `vev-ingest${resourceSuffix}` })],

      workersDev: preview ? false : undefined,
    },
  }
})
