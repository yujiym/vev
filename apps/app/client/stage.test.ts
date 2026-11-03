// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Clip, ClipSummary, Slot, TransitionSpec } from '@vev/shared'
import { describe, expect, it, vi } from 'vitest'

import type { Compositor } from './compositor.ts'
import type { MemoryStorage, ShowMemory } from './show-memory.ts'
import type { StartStageOptions } from './stage.ts'
import { startStage } from './stage.ts'

const fakeCompositor = () => {
  const calls = {
    dispose: 0,
    loads: [] as { code: string; slot: Slot }[],
    mounted: 0,
    resizes: [] as [number, number][],
    switches: [] as { at: number; slot: Slot; spec: TransitionSpec }[],
    ticks: [] as number[],
  }
  const compositor: Compositor = {
    dispose: () => {
      calls.dispose += 1
    },
    load: (slot, code) => {
      calls.loads.push({ code, slot })
    },
    mount: () => {
      calls.mounted += 1
    },
    resize: (width, height) => {
      calls.resizes.push([width, height])
    },
    switchTo: (slot, spec, at) => {
      calls.switches.push({ at, slot, spec })
    },
    tick: (now) => {
      calls.ticks.push(now)
    },
  }
  return { calls, compositor }
}

const fakeCanvas = () => {
  const listeners = new Map<string, () => void>()
  return {
    canvas: {
      addEventListener: (type: string, listener: () => void) => {
        listeners.set(type, listener)
      },
      height: 0,
      removeEventListener: (type: string) => {
        listeners.delete(type)
      },
      width: 0,
    } as unknown as HTMLCanvasElement,
    fire: (type: string) => listeners.get(type)?.(),
    listeners,
  }
}

const frames = () => {
  let next = 0
  const pending = new Map<number, () => void>()
  return {
    cancelFrame: (handle: number) => {
      pending.delete(handle)
    },
    fire: () => {
      const runs = [...pending.values()]
      pending.clear()
      for (const run of runs) {
        run()
      }
    },
    requestFrame: (run: () => void) => {
      next += 1
      pending.set(next, run)
      return next
    },
  }
}

const memoryStorage = (initial?: ShowMemory): MemoryStorage => {
  let value = initial === undefined ? null : JSON.stringify(initial)
  return {
    getItem: () => value,
    setItem: (_key, next) => {
      value = next
    },
  }
}

const clip = (id: string): Clip =>
  ({ code: `code of ${id}`, deps: { usesFeedback: false }, id, title: id.toUpperCase() }) as unknown as Clip
const summary = (id: string): ClipSummary => ({ id }) as unknown as ClipSummary

const start = async (overrides: Partial<StartStageOptions> = {}) => {
  const { calls, compositor } = fakeCompositor()
  const scheduler = frames()
  const { canvas, fire, listeners } = fakeCanvas()
  let resized: ((width: number, height: number) => void) | undefined
  const started = await startStage({
    cancelFrame: scheduler.cancelFrame,
    canvas,
    createCompositor: () => compositor,
    fetchClipById: async (id) => await Promise.resolve(clip(id)),
    fetchLibrarySummaries: async () => await Promise.resolve([summary('first')]),
    now: () => 5000,
    requestFrame: scheduler.requestFrame,
    storage: memoryStorage(),
    subscribeResize: (onResize) => {
      resized = onResize
      return () => {
        resized = undefined
      }
    },
    viewportSize: () => ({ height: 720, width: 1280 }),
    ...overrides,
  })
  return {
    calls,
    canvas,
    fire,
    listeners,
    resize: (w: number, h: number) => resized?.(w, h),
    scheduler,
    started,
  }
}

describe(startStage, () => {
  it('sizes the canvas, mounts the compositor and opens on the library’s first clip', async () => {
    const { calls, canvas } = await start()

    expect(canvas.width).toBe(1280)
    expect(canvas.height).toBe(720)
    expect(calls.mounted).toBe(1)
    expect(calls.loads).toStrictEqual([{ code: 'code of first', slot: 'a' }])
  })

  it('opens on a fixture when the library is empty or does not answer', async () => {
    const errors = vi.spyOn(console, 'error').mockReturnValue()
    const empty = await start({ fetchLibrarySummaries: async () => await Promise.resolve([]) })
    expect(empty.started.control.getSnapshot().current.clipId).toBe('quiet')

    const down = await start({
      fetchLibrarySummaries: async () => await Promise.reject(new Error('offline')),
    })
    expect(down.started.control.getSnapshot().current.clipId).toBe('quiet')
    errors.mockRestore()
  })

  it('drives the reducer and the picture from one loop, until it stops', async () => {
    const { calls, scheduler, started } = await start()

    scheduler.fire()
    scheduler.fire()
    expect(calls.ticks).toStrictEqual([5000, 5000])

    started.stop()
    scheduler.fire()
    expect(calls.ticks).toHaveLength(2)
    expect(calls.dispose).toBe(1)

    started.stop()
    expect(calls.dispose).toBe(1)
  })

  it('resizes through the compositor, never by mutating the canvas behind its back', async () => {
    const { calls, canvas, resize } = await start()

    resize(1920, 1080)

    expect(calls.resizes).toStrictEqual([[1920, 1080]])
    expect(canvas.width).toBe(1280)
  })

  it('says so when the picture cannot start, and keeps the controls working', async () => {
    const errors = vi.spyOn(console, 'error').mockReturnValue()
    const faults: string[] = []
    const { scheduler, started } = await start({
      createCompositor: () => {
        throw new Error('no WebGL')
      },
      onPictureFault: (message) => {
        faults.push(message)
      },
    })

    expect(faults[0]).toContain('failed to start')
    expect(() => {
      scheduler.fire()
      started.control.tap()
    }).not.toThrow()
    errors.mockRestore()
  })

  it('says so when the live context is lost, and stops listening when it stops', async () => {
    const errors = vi.spyOn(console, 'error').mockReturnValue()
    const faults: string[] = []
    const { fire, listeners, started } = await start({
      onPictureFault: (message) => {
        faults.push(message)
      },
    })

    fire('webglcontextlost')
    expect(faults[0]).toContain('lost its GPU context')

    started.stop()
    expect(listeners.size).toBe(0)
    errors.mockRestore()
  })

  it('comes back from a reload on the same clip, tempo, bar grid and blackout', async () => {
    const storage = memoryStorage()
    const first = await start({ storage })
    first.started.control.blackout()
    first.started.stop()

    const second = await start({
      fetchLibrarySummaries: async () => await Promise.resolve([summary('another')]),
      now: () => 9000,
      storage,
    })
    const snapshot = second.started.control.getSnapshot()
    expect(snapshot).toMatchObject({ bpm: 120, current: { clipId: 'first' }, panic: 'blackout' })
    // The first start's downbeat at 5000 survives, so 9000 is still a bar line of the same grid.
    expect(snapshot.barPhase).toBe(0)
  })

  it('does not bring back a freeze, because the frame it held is gone', async () => {
    const storage = memoryStorage()
    const first = await start({ storage })
    first.started.control.freeze()
    first.started.stop()

    const second = await start({ storage })
    expect(second.started.control.getSnapshot().panic).toBe('none')
  })

  it('falls back to the library when the remembered clip is gone', async () => {
    const errors = vi.spyOn(console, 'error').mockReturnValue()
    const storage = memoryStorage({ beatsPerBar: 4, blackout: false, bpm: 90, clipId: 'gone', downbeatAt: 0 })
    const { started } = await start({
      fetchClipById: async (id) =>
        id === 'gone' ? await Promise.reject(new Error('404')) : await Promise.resolve(clip(id)),
      storage,
    })
    expect(started.control.getSnapshot().current.clipId).toBe('first')
    expect(started.control.getSnapshot().bpm).toBe(90)
    errors.mockRestore()
  })
})
