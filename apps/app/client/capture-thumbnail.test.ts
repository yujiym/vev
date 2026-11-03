// SPDX-License-Identifier: AGPL-3.0-or-later
import { afterEach, describe, expect, it, vi } from 'vitest'

import { captureThumbnail } from './register-clip.ts'

/**
 * `captureThumbnail` is driven by `requestAnimationFrame`, which a node test has not got. This
 * stands in a frame loop the test steps by hand, with a clock it advances, so the order of events
 * inside one tick is observable.
 */
const createFrameLoop = () => {
  let pending: (() => void) | null = null
  let clock = 0
  vi.stubGlobal('requestAnimationFrame', (onFrame: () => void) => {
    pending = onFrame
    return 1
  })
  vi.stubGlobal('cancelAnimationFrame', () => {
    pending = null
  })
  return {
    now: () => clock,
    step: (toMs: number) => {
      clock = toMs
      const frame = pending
      pending = null
      frame?.()
    },
  }
}

type Capture = Awaited<ReturnType<typeof captureThumbnail>>
type Snapshot = NonNullable<NonNullable<Parameters<typeof captureThumbnail>[3]>['snapshot']>
type Encode = NonNullable<NonNullable<Parameters<typeof captureThumbnail>[3]>['encode']>

const CANVAS = { height: 180, width: 320 } as HTMLCanvasElement
const RECORDING_MS = 3000
const FRAME_MS = 100

const copyOf = (index: number): HTMLCanvasElement => ({ index }) as unknown as HTMLCanvasElement

const encodeAsText: Encode = async (frame) =>
  await Promise.resolve(new Blob([`jpeg-${(frame as unknown as { index: number }).index}`]))

interface Recorded {
  /** In order: `tick@<ms>` when the compositor drew, `sample@<ms>` for the palette, `snapshot@<ms>` for a still. */
  readonly events: string[]
  readonly result: Capture
  readonly sizes: { height: number; width: number }[]
}

/** Steps a 3000ms recording in 100ms frames and resolves the recorder at the end. */
const recordThrough = async (
  overrides: { readonly encode?: Encode; readonly snapshot?: Snapshot } = {},
): Promise<Recorded> => {
  const loop = createFrameLoop()
  const events: string[] = []
  const sizes: { height: number; width: number }[] = []
  const recording = Promise.withResolvers<Blob>()
  const compositor = {
    dispose: () => events.push('dispose'),
    load: vi.fn<() => void>(),
    mount: vi.fn<() => void>(),
    switchTo: vi.fn<() => void>(),
    tick: () => events.push(`tick@${loop.now()}`),
  }

  const capture = captureThumbnail('osc().out()', CANVAS, RECORDING_MS, {
    createCompositor: async () => await Promise.resolve(compositor as never),
    encode: overrides.encode ?? encodeAsText,
    now: loop.now,
    record: async () => await recording.promise,
    sample: () => {
      events.push(`sample@${loop.now()}`)
      return { data: [10, 20, 30, 255] }
    },
    snapshot:
      overrides.snapshot ??
      ((_canvas, size) => {
        events.push(`snapshot@${loop.now()}`)
        sizes.push(size)
        return copyOf(sizes.length - 1)
      }),
  })
  // Let `captureThumbnail` get past `await createCompositor` and register its first frame.
  await Promise.resolve()
  await Promise.resolve()
  for (let at = FRAME_MS; at <= RECORDING_MS; at += FRAME_MS) {
    loop.step(at)
  }
  recording.resolve(new Blob(['webm'], { type: 'video/webm' }))
  return { events, result: await capture, sizes }
}

describe(captureThumbnail, () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns three JPEG stills in recording order alongside the thumbnail and palette', async () => {
    const { result } = await recordThrough()

    await expect(Promise.all(result.stills.map(async (still) => await still.text()))).resolves.toStrictEqual([
      'jpeg-0',
      'jpeg-1',
      'jpeg-2',
    ])
    expect(result.blob.type).toBe('video/webm')
    expect(result.palette).toHaveLength(1)
  })

  it('spreads the stills across the recording', async () => {
    const { events } = await recordThrough()
    expect(events.filter((event) => event.startsWith('snapshot@'))).toStrictEqual([
      'snapshot@500',
      'snapshot@1500',
      'snapshot@2500',
    ])
  })

  it('copies each still inside the tick that just drew it, never between ticks', async () => {
    const { events } = await recordThrough()

    const copies = events.filter((event) => event.startsWith('snapshot@'))
    for (const copy of copies) {
      const [, at] = copy.split('@')
      const tickAt = events.indexOf(`tick@${at}`)
      const between = events.slice(tickAt + 1, events.indexOf(copy))
      expect(tickAt).toBeGreaterThanOrEqual(0)
      expect(between.filter((event) => event.startsWith('tick@'))).toStrictEqual([])
    }
  })

  it('resizes the frames to a size jev accepts rather than the canvas size', async () => {
    const { sizes } = await recordThrough()
    expect(sizes).toStrictEqual(Array.from({ length: 3 }, () => ({ height: 288, width: 512 })))
  })

  it('still returns the thumbnail and palette when copying a frame throws, and keeps the other stills', async () => {
    let calls = 0
    const { result } = await recordThrough({
      snapshot: () => {
        calls += 1
        if (calls === 2) {
          throw new Error('drawImage refused')
        }
        return copyOf(calls)
      },
    })

    expect(result.blob.type).toBe('video/webm')
    expect(result.palette).toHaveLength(1)
    expect(result.stills).toHaveLength(2)
  })

  it('still returns the thumbnail when encoding every frame fails, with no stills', async () => {
    const { result } = await recordThrough({
      encode: async () => await Promise.reject(new Error('toBlob produced nothing')),
    })

    expect(result.blob.type).toBe('video/webm')
    expect(result.palette).toHaveLength(1)
    expect(result.stills).toStrictEqual([])
  })

  it('disposes the compositor after the recording', async () => {
    const { events } = await recordThrough()
    expect(events.at(-1)).toBe('dispose')
  })
})
