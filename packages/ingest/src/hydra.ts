// SPDX-License-Identifier: AGPL-3.0-or-later
import { countOutCalls, outCallTargets } from '@vev/engines'
import type { ClipDeps, SourceReq } from '@vev/shared'

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
 * Output calls are read with `@vev/engines`'s scanner (`countOutCalls` / `outCallTargets`), never
 * with a regex of this module's own. There is exactly one answer to "which buffers does this clip
 * name", and `probeClip` and `POST /api/clips` refuse a multi-output clip from that same answer —
 * a second implementation here would only mean a clip could pass the gate counted one way and be
 * stored counted another (which it did: a `.out(` inside a line comment was counted, and one
 * written `. out (o3)` was missed).
 *
 * `isolated` follows from the CALL COUNT, not from `outputsUsed`'s length: two bare `.out()` calls
 * name no buffer at all and still need their own Hydra instance (§6.1), because a clip may write
 * only the one buffer its slot owns.
 */
export const analyzeHydra = (code: string): ClipDeps & { isolated: boolean } => {
  const outputsUsed = [...new Set(outCallTargets(code))]
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
    isolated: countOutCalls(code) > 1,
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
