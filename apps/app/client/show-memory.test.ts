// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest'

import type { MemoryStorage } from './show-memory.ts'
import { createShowMemoryWriter, readShowMemory } from './show-memory.ts'

const fakeStorage = (initial: string | null = null) => {
  let value = initial
  const writes: string[] = []
  const storage: MemoryStorage = {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next
      writes.push(next)
    },
  }
  return { storage, writes }
}

const MEMORY = { beatsPerBar: 4, blackout: true, bpm: 128, clipId: 'loud', downbeatAt: 1000 }

describe('the show memory', () => {
  it('reads back what it wrote', () => {
    const { storage } = fakeStorage()
    createShowMemoryWriter(storage)(MEMORY)
    expect(readShowMemory(storage)).toStrictEqual(MEMORY)
  })

  it('remembers nothing on a first load', () => {
    expect(readShowMemory(fakeStorage().storage)).toBeUndefined()
  })

  it('writes only when something changed', () => {
    const { storage, writes } = fakeStorage()
    const write = createShowMemoryWriter(storage)
    write(MEMORY)
    write({ ...MEMORY })
    expect(writes).toHaveLength(1)
    write({ ...MEMORY, bpm: 140 })
    expect(writes).toHaveLength(2)
  })

  it('treats anything unreadable as no memory, so a reload cannot fail on it', () => {
    const errors = vi.spyOn(console, 'error').mockReturnValue()
    expect(readShowMemory(fakeStorage('{not json').storage)).toBeUndefined()
    expect(readShowMemory(fakeStorage('{"bpm":"fast"}').storage)).toBeUndefined()
    errors.mockRestore()
  })

  it('a store that refuses a write costs the memory, not the show', () => {
    const errors = vi.spyOn(console, 'error').mockReturnValue()
    const write = createShowMemoryWriter({
      getItem: () => null,
      setItem: () => {
        throw new Error('quota')
      },
    })
    expect(() => {
      write(MEMORY)
    }).not.toThrow()
    errors.mockRestore()
  })
})
