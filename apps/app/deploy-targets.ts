// SPDX-License-Identifier: AGPL-3.0-or-later
const shared = {
  compatibility_date: '2026-09-01',
  compatibility_flags: ['nodejs_compat'],
}

const database = (id: string, name: string) => ({
  binding: 'DB',
  database_id: id,
  database_name: name,
  migrations_dir: './db/migrations',
})

const vars = (mode: 'cloud' | 'local') => ({
  ACCESS_AUD:
    mode === 'cloud'
      ? '2751fc6207bcfd7f632e739f25ffd5a12a8325b4fcd8825fb9cbeac9bdf01ffd'
      : 'unused-in-local-mode',
  ACCESS_TEAM_DOMAIN: mode === 'cloud' ? '710gs.cloudflareaccess.com' : 'unused-in-local-mode',
  SOURCE_URL: 'https://github.com/yujiym/vev',
  VEV_MODE: mode,
})

export const targets = {
  // Workers AI has no local implementation, and a venue has no network (§15.3).
  local: {
    ...shared,
    d1_databases: [database('9b91c754-01f5-4399-98a7-bc8b5c9e65e8', 'vev')],
    name: 'vev-local',
    r2_buckets: [{ binding: 'MEDIA', bucket_name: 'vev-media' }],
    vars: vars('local'),
  },
  // Access protects only the custom domain, so both workers.dev paths stay closed (§13).
  preview: {
    ...shared,
    ai: { binding: 'AI' },
    d1_databases: [database('bcee626b-7dbd-4456-8fb9-a708583e6e1d', 'vev-preview')],
    name: 'vev-preview',
    preview_urls: false,
    r2_buckets: [{ binding: 'MEDIA', bucket_name: 'vev-media-preview' }],
    routes: [{ custom_domain: true, pattern: 'vev-preview.0x7.sh' }],
    vars: vars('cloud'),
    workers_dev: false,
  },
  // No route yet (M12), so this Worker is unreachable until one is attached. Closing both paths now
  // keeps it from being served outside Access in the meantime.
  production: {
    ...shared,
    ai: { binding: 'AI' },
    d1_databases: [database('6554a370-8884-4cbb-9f87-9d891a34ddcd', 'vev')],
    name: 'vev',
    preview_urls: false,
    r2_buckets: [{ binding: 'MEDIA', bucket_name: 'vev-media' }],
    vars: vars('cloud'),
    workers_dev: false,
  },
}
