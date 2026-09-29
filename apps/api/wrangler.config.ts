// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineWranglerConfig } from 'wrangler/experimental-config'

export default defineWranglerConfig({
  assetsDirectory: process.env.VEV_ASSETS_DIRECTORY ?? '../web/build',
  types: { generate: false },
})
