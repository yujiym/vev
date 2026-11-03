// SPDX-License-Identifier: AGPL-3.0-or-later
import { TAG_VOCABULARY } from '@vev/shared'
import { describe, expect, it } from 'vitest'

import { interpretDirection } from './direction.ts'

const TAGS_IN_USE = new Set([...TAG_VOCABULARY.map((tag) => tag.name), 'feedback', 'audio-reactive'])

describe('the tag dictionary', () => {
  it('reads a Japanese word for darker as lower energy and calmer tags', () => {
    const direction = interpretDirection('暗く', 1)

    expect(direction).toMatchObject({
      at: 1,
      energyTarget: 2,
      energyTrend: 'fall',
      source: 'dictionary',
      text: '暗く',
    })
    expect(direction.tags).toContain('monochrome')
  })

  it('reads the English equivalent the same way', () => {
    expect(interpretDirection('darker', 0)).toMatchObject({
      energyTarget: 2,
      energyTrend: 'fall',
      source: 'dictionary',
    })
  })

  it('reads a Japanese word for faster as higher energy and faster tags', () => {
    const direction = interpretDirection('速く', 0)

    expect(direction.energyTarget).toBe(4)
    expect(direction.energyTrend).toBe('rise')
    expect(direction.tags).toContain('strobe')
  })

  it('reads 文字 as the text tag', () => {
    expect(interpretDirection('文字', 0).tags).toContain('text')
  })

  it('accumulates tags from several words', () => {
    const direction = interpretDirection('文字とグリッチ', 0)
    expect(direction.tags).toStrictEqual(['text', 'glitch'])
  })

  it('lets the last word settle the scalar fields while tags accumulate', () => {
    const direction = interpretDirection('darker, then faster', 0)

    expect(direction.energyTarget).toBe(4)
    expect(direction.energyTrend).toBe('rise')
    expect(direction.tags).toContain('minimal')
    expect(direction.tags).toContain('strobe')
  })

  it('does not match an English word inside a longer word', () => {
    expect(interpretDirection('texture', 0).tags).toBeUndefined()
  })

  it('returns a usable direction for words the dictionary does not know', () => {
    const direction = interpretDirection('play something surprising', 7)

    expect(direction).toStrictEqual({ at: 7, source: 'dictionary', text: 'play something surprising' })
  })

  it('emits only tags a clip can actually carry', () => {
    const sentences = [
      '暗く',
      'darker',
      'bright',
      'faster',
      'ゆっくり',
      'text',
      'カラフル',
      'glitch and noise',
      'kaleidoscope',
      'feedback',
      'audio-reactive',
      'strobe',
      'wave',
      'rotate',
      'scroll',
      'pulse',
      'distort',
      'monochrome',
    ]

    for (const sentence of sentences) {
      for (const tag of interpretDirection(sentence, 0).tags ?? []) {
        expect(TAGS_IN_USE.has(tag), `${sentence} produced unknown tag ${tag}`).toBe(true)
      }
    }
  })
})
