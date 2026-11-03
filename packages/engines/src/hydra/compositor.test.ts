// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from 'vitest'

import type { Clock } from '../clock.ts'
import { HydraCompositor } from './compositor.ts'

/**
 * What a clip's code tells the fake Hydra below to do when it builds its chain. The real ones
 * cannot be had here: `hydra-synth` touches `window` at import time, so this file stands a fake in
 * for it, shaped after what `src/glsl-source.js` and `src/output.js` actually do (read, and
 * confirmed in a browser against 1.4.0, in the commit that added this).
 */
const FAKE = {
  /** `.out()` builds a command whose program WebGL then refuses to link: the draw raises INVALID_OPERATION. */
  badGlsl: "paint('bad-glsl')",
  fine: "paint('fine')",
  /** `.out()` hits an error generating GLSL, logs it and returns: the output keeps its old command. */
  swallowed: "paint('swallowed')",
}

const GL_INVALID_OPERATION = 1282

interface FakeGl {
  readonly NO_ERROR: 0
  drawingBufferHeight: number
  drawingBufferWidth: number
  errors: number[]
  getError: () => number
}

// The factory returns an export the real module does not have (`gl`, so a test can raise errors on
// it), which the typed `import()` form of `vi.mock` would refuse.
// The factory is registered at hoist time and run on first import of `hydra-synth`, so everything it
// needs is created inside it and handed out through the fake instance.
// oxlint-disable-next-line vitest/prefer-import-in-mock -- the factory adds an export the real module lacks
vi.mock('hydra-synth', () => {
  const gl: FakeGl = {
    NO_ERROR: 0,
    drawingBufferHeight: 180,
    drawingBufferWidth: 320,
    errors: [],
    getError: () => gl.errors.shift() ?? 0,
  }

  const makeOutput = (label: string) => {
    const output = {
      draw: () => {
        // The command a fresh output starts with.
      },
      getCurrent: () => ({}),
      label,
      linked: true,
      tick: () => {
        if (!output.linked) {
          gl.errors.push(1282)
        }
      },
    }
    return output
  }

  class FakeHydra {
    readonly regl = { _gl: gl, destroy: vi.fn<() => void>(), read: vi.fn<() => Uint8Array>() }
    readonly synth: object

    constructor() {
      const outputs = Object.fromEntries(['o0', 'o1', 'o2', 'o3'].map((name) => [name, makeOutput(name)]))
      this.synth = {
        ...outputs,
        bpm: 120,
        mouse: {},
        paint: (kind: string) => ({
          out: (target?: ReturnType<typeof makeOutput>) => {
            if (target === undefined || kind === 'swallowed') {
              return
            }
            target.draw = () => {
              // A new command replaces the old one.
            }
            target.linked = kind !== 'bad-glsl'
          },
        }),
        render: vi.fn<() => void>(),
        src: () => ({ blend: () => ({ out: vi.fn<() => void>() }), out: vi.fn<() => void>() }),
        time: 0,
      }
    }

    tick = vi.fn<() => void>()
    setResolution = vi.fn<() => void>()
  }

  return { default: FakeHydra, gl }
})

const clock: Clock = { beatsPerBar: 4, bpm: 120, downbeatAt: 0 }

const mounted = async () => {
  const compositor = new HydraCompositor(clock)
  compositor.mount({} as HTMLCanvasElement)
  const fake = await import('hydra-synth')
  // The mocked module's extra export, which the real one does not have.
  const { gl } = fake as unknown as { gl: FakeGl }
  gl.errors.length = 0
  return { compositor, gl }
}

describe('HydraCompositor.load', () => {
  it('takes a clip whose shader links', async () => {
    const { compositor } = await mounted()
    expect(() => {
      compositor.load('a', `${FAKE.fine}.out()`)
    }).not.toThrow()
  })

  it('refuses a clip whose program WebGL will not link, and says why', async () => {
    const { compositor } = await mounted()
    expect(() => {
      compositor.load('a', `${FAKE.badGlsl}.out()`)
    }).toThrow(/refused its shader/u)
  })

  it('refuses a clip whose `.out()` swallowed its own error and left the buffer as it was', async () => {
    const { compositor } = await mounted()
    expect(() => {
      compositor.load('b', `${FAKE.swallowed}.out()`)
    }).toThrow(/could not be built/u)
  })

  it('leaves the slot with the clip it had when the new one is refused', async () => {
    const { compositor } = await mounted()
    compositor.load('a', `${FAKE.fine}.out()`)
    expect(() => {
      compositor.load('a', `${FAKE.badGlsl}.out()`)
    }).toThrow(/refused its shader/u)

    // The refused program is gone, so the next frame does not draw it and raise an error every time.
    expect(() => {
      compositor.load('a', `${FAKE.fine}.out()`)
    }).not.toThrow()
  })

  it('does not blame a clip for a GL error that was already waiting', async () => {
    const { compositor, gl } = await mounted()
    gl.errors.push(GL_INVALID_OPERATION, GL_INVALID_OPERATION)
    expect(() => {
      compositor.load('a', `${FAKE.fine}.out()`)
    }).not.toThrow()
  })

  it('still throws what a clip’s own code throws', async () => {
    const { compositor } = await mounted()
    expect(() => {
      compositor.load('a', 'nope()')
    }).toThrow(ReferenceError)
  })
})
