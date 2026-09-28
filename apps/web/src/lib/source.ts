// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The AGPL §13 source offer: a link to the exact commit being served (§14.1).
 * `dev` means the build carries no commit, so the link points at the repository.
 */
export const sourceCommitUrl = (sourceUrl: string, commit: string): string => {
  const base = sourceUrl.replace(/\/+$/u, '')

  return commit === 'dev' ? base : `${base}/tree/${commit}`
}
