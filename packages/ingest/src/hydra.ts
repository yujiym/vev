// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ClipDeps, SourceReq } from '@vev/shared'

const OUTPUT_RE = /\.out\(\s*(?<value>o[0-3])\s*\)/gu
const FEEDBACK_RE = /\bsrc\(\s*o0\s*\)/u
const AUDIO_RE = /\ba\.[a-zA-Z]/u
const LOAD_SCRIPT_RE = /\bloadScript\(\s*['"](?<value>[^'"]+)['"]/gu
const SOURCE_INIT_RE = /\bs[0-3]\.init(?<kind>Cam|Video|Image|Screen)\(/gu

/** Maps a `sN.init<Kind>()` call's captured kind to the `SourceReq` spec §5 `deps.sourcesUsed` uses. */
const sourceKindFor = (kind: string): SourceReq | undefined => {
  switch (kind) {
    case 'Cam': {
      return 'cam'
    }
    case 'Image': {
      return 'image'
    }
    case 'Screen': {
      return 'screen'
    }
    case 'Video': {
      return 'video'
    }
    default: {
      return undefined
    }
  }
}

const uniqueMatches = (code: string, re: RegExp): string[] => [
  ...new Set(
    [...code.matchAll(re)].map((match) => match.groups?.value).filter((value) => value !== undefined),
  ),
]

/**
 * Detects a Hydra clip's runtime requirements from its source (spec §5 `Clip.deps`, §6.1) — feedback
 * (`src(o0)`), which output buffers it targets, camera/video/image/screen sources it initializes,
 * audio reactivity (`a.fft` etc.) and external scripts it loads via `loadScript`. Purely textual: no
 * DOM, no Hydra instance, no Worker APIs, so it runs the same in the browser and the Worker (§11.1).
 *
 * `isolated` follows directly from `outputsUsed`: a clip that targets more than one output buffer
 * needs its own Hydra instance (§6.1) and cannot share the compositor's.
 */
export const analyzeHydra = (code: string): ClipDeps & { isolated: boolean } => {
  const outputsUsed = uniqueMatches(code, OUTPUT_RE)
  const sourcesUsed = [
    ...new Set(
      [...code.matchAll(SOURCE_INIT_RE)]
        .map((match) => match.groups?.kind)
        .filter((kind): kind is string => kind !== undefined)
        .map((kind) => sourceKindFor(kind))
        .filter((kind): kind is SourceReq => kind !== undefined),
    ),
  ]
  const extensions = uniqueMatches(code, LOAD_SCRIPT_RE)

  return {
    extensions,
    isolated: outputsUsed.length > 1,
    outputsUsed,
    sourcesUsed,
    usesAudio: AUDIO_RE.test(code),
    usesFeedback: FEEDBACK_RE.test(code),
  }
}

/**
 * Normalizes a pasted Hydra clip's code. This milestone does exactly one thing: trim leading and
 * trailing whitespace. `.out()` target rewriting (bare `.out()` → `.out(o1)` / `.out(o2)`) already
 * lives in `@vev/engines`'s compositor, and turning numeric parameters into macros (§11) is out of
 * scope for M2 — do not add either here without a spec change; this function stays a single trim.
 */
export const normalizeHydra = (code: string): string => code.trim()
