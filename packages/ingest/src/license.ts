// SPDX-License-Identifier: AGPL-3.0-or-later

/** What a leading comment header stated, and only what it stated — see `extractLicense`. */
export interface ExtractedLicenseInfo {
  author?: string
  license?: string
  sourceUrl?: string
}

const AUTHOR_RE = /^\s*(?:\/\/|\*|#)?\s*@author[:\s]+(?<value>.+?)\s*$/imu
const LICENSE_RE = /^\s*(?:\/\/|\*|#)?\s*license[:\s]+(?<value>.+?)\s*$/imu
const SOURCE_RE = /^\s*(?:\/\/|\*|#)?\s*source[:\s]+(?<value>.+?)\s*$/imu

/**
 * Reads a clip's leading comment header for license, author and source-url lines (spec §11, §14.2).
 * Code with no such header returns an empty object rather than inventing a value — an unstated
 * licence is recorded as `"unknown"` at the API boundary (§14.2), and guessing here would defeat
 * that: the whole point is that a gap stays a gap until a human states otherwise.
 */
export const extractLicense = (code: string): ExtractedLicenseInfo => {
  const info: ExtractedLicenseInfo = {}

  const author = AUTHOR_RE.exec(code)?.groups?.value
  if (author !== undefined) {
    info.author = author
  }

  const license = LICENSE_RE.exec(code)?.groups?.value
  if (license !== undefined) {
    info.license = license
  }

  const sourceUrl = SOURCE_RE.exec(code)?.groups?.value
  if (sourceUrl !== undefined) {
    info.sourceUrl = sourceUrl
  }

  return info
}
