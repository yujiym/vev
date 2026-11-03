// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The AGPL §13 source offer: a link to the exact commit being served (§14.1).
 * `dev` means the build carries no commit, so the link points at the repository.
 */
export const sourceCommitUrl = (sourceUrl: string, commit: string): string => {
  const base = sourceUrl.replace(/\/+$/u, '')

  return commit === 'dev' ? base : `${base}/tree/${commit}`
}

/**
 * A `sourceUrl` that isn't set is not "use the upstream repository" — that
 * would let a self-hoster's modified build silently point every visitor at
 * vev's own source instead of theirs, which is the one AGPL §13 failure that
 * matters (§14.1). It renders as a visible "not configured" state instead. A
 * documented default lives in the tracked `apps/web/.env`, not as a fallback
 * here.
 */
export type SourceLink = { kind: 'link'; href: string } | { kind: 'missing' }

export const resolveSourceLink = (sourceUrl: string | undefined, commit: string): SourceLink =>
  sourceUrl !== undefined && sourceUrl.length > 0
    ? { href: sourceCommitUrl(sourceUrl, commit), kind: 'link' }
    : { kind: 'missing' }
