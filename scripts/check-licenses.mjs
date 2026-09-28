// SPDX-License-Identifier: AGPL-3.0-or-later
// Dependency licence policy (§14.1): only licences compatible with AGPL-3.0.
// GPL-2.0-only and unknown licences fail. Run: pnpm licenses:check
import { execFileSync } from 'node:child_process'

const ALLOWED = new Set([
  '0BSD',
  'AGPL-3.0',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'Apache-2.0',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'BlueOak-1.0.0',
  'CC0-1.0',
  'GPL-3.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'ISC',
  'LGPL-2.1-or-later',
  'LGPL-3.0-or-later',
  'MIT',
  'MPL-2.0',
  'Python-2.0',
  'Unlicense',
])

/** @typedef {{ name: string, versions: string[] }} LicensedPackage */

/**
 * Parse and validate `pnpm licenses list --prod --json` output.
 *
 * pnpm groups packages by licence and gives each package a `versions` array
 * (every installed version under that licence), not a single `version`
 * string — confirmed by running the command against this tree and
 * inspecting the real output.
 *
 * A check that silently passes because it parsed nothing is worse than no
 * check, so this throws rather than returning an empty result when the
 * shape does not match what pnpm is known to produce, or when there are no
 * packages at all (this tree has production dependencies, so zero packages
 * can only mean the parser broke).
 * @param {string} json - the raw stdout of `pnpm licenses list --prod --json`
 * @returns {Record<string, LicensedPackage[]>} the parsed, shape-checked licence groups
 */
const parseLicenseGroups = (json) => {
  // oxlint-disable-next-line typescript/no-unsafe-assignment -- JSON.parse of untrusted external output is inherently `any`; validated below before use
  const parsed = JSON.parse(json)
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- validating the shape of untrusted external JSON requires a runtime typeof probe; there is no I/O boundary parser for pnpm's ad hoc CLI output
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new TypeError('Expected `pnpm licenses list --prod --json` to return an object keyed by licence.')
  }

  let packageCount = 0
  // oxlint-disable-next-line typescript/no-unsafe-argument -- `parsed` is validated to be a plain object above; Object.entries needs no further narrowing to iterate it safely
  for (const [license, packages] of Object.entries(parsed)) {
    if (!Array.isArray(packages)) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- reporting the actual runtime shape of untrusted JSON in the error message
      throw new TypeError(`Expected an array of packages for licence "${license}", got ${typeof packages}.`)
    }
    for (const pkg of packages) {
      // oxlint-disable-next-line anti-slop/no-runtime-typeof, typescript/no-unsafe-member-access -- this is the type guard itself: probing an unknown array element's shape before it can be treated as LicensedPackage
      if (typeof pkg?.name !== 'string' || !Array.isArray(pkg?.versions)) {
        throw new TypeError(
          `Expected a package with a string "name" and a "versions" array under licence "${license}".`,
        )
      }
      packageCount += 1
    }
  }

  if (packageCount === 0) {
    throw new TypeError(
      'Expected at least one production package; the parser or the pnpm command output may have changed shape.',
    )
  }

  // The loop above has validated every entry against LicensedPackage's shape; this cast is the payoff of that guard.
  /** @type {Record<string, LicensedPackage[]>} */
  // oxlint-disable-next-line typescript/no-unsafe-assignment, typescript/no-unsafe-type-assertion -- validated by the shape check above, not inferred
  const validated = parsed
  return validated
}

const raw = execFileSync('pnpm', ['licenses', 'list', '--prod', '--json'], { encoding: 'utf-8' })
const groups = parseLicenseGroups(raw)
const offenders = []

for (const [license, packages] of Object.entries(groups)) {
  // A dual licence passes when any one of its options is allowed.
  const options = license.split(/\s+OR\s+/u).map((option) => option.replaceAll(/[()]/gu, '').trim())
  if (options.some((option) => ALLOWED.has(option))) {
    continue
  }

  for (const pkg of packages) {
    offenders.push(`${pkg.name}@${pkg.versions.join(', ')}: ${license}`)
  }
}

if (offenders.length > 0) {
  console.error(`Disallowed dependency licences (§14.1):\n${offenders.join('\n')}`)
  process.exit(1)
}

console.log('All production dependency licences are AGPL-3.0 compatible.')
