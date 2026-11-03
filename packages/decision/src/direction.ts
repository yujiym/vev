// SPDX-License-Identifier: AGPL-3.0-or-later
import type { ClipEnergy, Direction } from '@vev/shared'

/**
 * Words the tag dictionary understands, and what each asks for (spec §8.5).
 *
 * This is the first step of §8.6's two-step interpretation chain: instant, offline, and good
 * enough to steer the next request on its own. It runs identically in a Worker and in the browser,
 * which is why the direction it returns is plain data rather than a call.
 *
 * `tags` prefer; they do not filter. `energyTarget` and `energyTrend` steer ranking. A word that
 * only implies movement ("faster") sets both, because a clip that is tagged fast but calm would
 * otherwise satisfy the instruction.
 */
interface DictionaryEntry {
  readonly energyTarget?: ClipEnergy
  readonly energyTrend?: Direction['energyTrend']
  readonly keywords: readonly string[]
  readonly tags: readonly string[]
}

const DICTIONARY: readonly DictionaryEntry[] = [
  {
    energyTarget: 2,
    energyTrend: 'fall',
    keywords: [
      'calm',
      'calmer',
      'dark',
      'darker',
      'darkest',
      'quiet',
      'quieter',
      '暗い',
      '暗く',
      '暗め',
      '静か',
    ],
    tags: ['minimal', 'monochrome'],
  },
  {
    energyTarget: 4,
    energyTrend: 'rise',
    keywords: ['bright', 'brighter', 'brightest', 'light', '明るい', '明るく'],
    tags: ['gradient', 'saturated'],
  },
  {
    energyTarget: 4,
    energyTrend: 'rise',
    keywords: ['accelerate', 'fast', 'faster', 'speed', 'upbeat', '速い', '速く', 'スピード'],
    tags: ['scrolling', 'strobe'],
  },
  {
    energyTarget: 2,
    energyTrend: 'fall',
    keywords: ['slow', 'slower', 'slowly', 'ゆっくり', '遅い', '遅く'],
    tags: ['gradient', 'organic'],
  },
  {
    keywords: ['ascii', 'letters', 'text', 'typography', 'テキスト', 'タイポ', '文字'],
    tags: ['text'],
  },
  {
    keywords: ['colourful', 'colorful', 'vivid', 'カラフル', 'カラー', '鮮やか'],
    tags: ['psychedelic', 'saturated'],
  },
  {
    keywords: ['geometric', 'shapes', '図形', '幾何'],
    tags: ['geometric', 'grid'],
  },
  {
    keywords: ['flowing', 'organic', '自然', '有機'],
    tags: ['organic'],
  },
  {
    keywords: ['broken', 'glitch', 'corrupted', 'グリッチ', '壊れ'],
    tags: ['glitch'],
  },
  {
    keywords: ['noise', 'noisy', 'grain', 'ノイズ'],
    tags: ['noise'],
  },
  {
    keywords: ['minimal', 'simple', 'シンプル', 'ミニマル'],
    tags: ['minimal'],
  },
  {
    keywords: ['psychedelic', 'trippy', 'サイケ', '幻覚'],
    tags: ['psychedelic'],
  },
  {
    keywords: ['kaleidoscope', 'kaleidoscopic', 'カレイド', '万華鏡'],
    tags: ['kaleidoscope'],
  },
  {
    keywords: ['feedback', 'フィードバック'],
    tags: ['feedback'],
  },
  {
    energyTarget: 5,
    keywords: ['flash', 'strobe', '点滅', 'ストロボ'],
    tags: ['strobe'],
  },
  {
    keywords: ['grid', 'tile', 'tiled', 'グリッド', '格子'],
    tags: ['grid'],
  },
  {
    keywords: ['wave', 'waves', '波形', '波'],
    tags: ['waveform'],
  },
  {
    keywords: ['rotate', 'rotating', 'rotation', 'spin', 'スピン', '回転'],
    tags: ['rotation'],
  },
  {
    keywords: ['scroll', 'scrolling', 'スクロール'],
    tags: ['scrolling'],
  },
  {
    keywords: ['beat', 'pulse', 'pulsing', 'パルス', '脈'],
    tags: ['pulsing'],
  },
  {
    keywords: ['distort', 'distorted', 'distortion', 'ゆがみ', '歪み'],
    tags: ['distortion'],
  },
  {
    keywords: ['greyscale', 'grayscale', 'monochrome', 'モノクロ', '白黒'],
    tags: ['monochrome'],
  },
  {
    keywords: ['audio', 'audio-reactive', 'オーディオ', '音'],
    tags: ['audio-reactive'],
  },
]

const ASCII_WORD = /^[a-z-]+$/u

/**
 * Where `keyword` first appears, or -1. English words match on word boundaries so "text" does not
 * fire inside "texture"; Japanese has no such delimiter and matches as a substring.
 */
const firstMatch = (text: string, keyword: string): number =>
  ASCII_WORD.test(keyword) ? text.search(new RegExp(`\\b${keyword}\\b`, 'iu')) : text.indexOf(keyword)

/**
 * Spec §8.5's tag dictionary: a sentence in, a `Direction` out.
 *
 * The LAST thing mentioned wins for the scalar fields. "Darker, then faster" is a refinement, and
 * the performer's latest word is the one they mean; tags accumulate instead, because asking for
 * text and glitch is asking for both.
 *
 * `at` is a parameter rather than `Date.now()` here: interpretation is otherwise deterministic, and
 * a caller that logs the direction already owns the clock. It never throws and never returns a
 * partially filled direction — an unrecognized sentence yields a direction with text and nothing
 * else, which ranks by section and energy exactly as if no direction had been given.
 */
export const interpretDirection = (text: string, at: number): Direction => {
  const matched = DICTIONARY.flatMap((entry) => {
    const indexes = entry.keywords.map((keyword) => firstMatch(text, keyword)).filter((index) => index >= 0)
    return indexes.length === 0 ? [] : [{ entry, index: Math.min(...indexes) }]
  }).toSorted((a, b) => a.index - b.index)

  const tags: string[] = []
  let energyTarget: ClipEnergy | undefined
  let energyTrend: Direction['energyTrend']
  for (const { entry } of matched) {
    for (const tag of entry.tags) {
      if (!tags.includes(tag)) {
        tags.push(tag)
      }
    }
    energyTarget = entry.energyTarget ?? energyTarget
    energyTrend = entry.energyTrend ?? energyTrend
  }

  const direction: Direction = { at, source: 'dictionary', text }
  if (tags.length > 0) {
    direction.tags = tags
  }
  if (energyTarget !== undefined) {
    direction.energyTarget = energyTarget
  }
  if (energyTrend !== undefined) {
    direction.energyTrend = energyTrend
  }
  return direction
}
