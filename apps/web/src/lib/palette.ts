// SPDX-License-Identifier: AGPL-3.0-or-later

/** RGBA pixel data for one sampled frame — what `canvas.getContext('2d').getImageData(...).data` returns. */
export interface SampledFrame {
  readonly data: Uint8ClampedArray | readonly number[]
}

/** Channel values are bucketed to this granularity before being counted — two near-identical shades of the same colour should count as one dominant colour, not two. */
const BUCKET_SIZE = 32

/** How many dominant colours `dominantColours` returns at most. */
const DEFAULT_MAX_COLOURS = 5

const bucket = (value: number): number => Math.min(255, Math.round(value / BUCKET_SIZE) * BUCKET_SIZE)

const toHexByte = (value: number): string => value.toString(16).padStart(2, '0')

/**
 * The dominant colours actually rendered, as hex strings — this is the palette, computed from
 * what a clip's probed frames actually drew rather than guessed from its code by a model (spec
 * §11). Pure: given sampled pixel data, it returns colours in descending order of how much of the
 * sampled area they cover.
 *
 * Colours are bucketed to `BUCKET_SIZE` before counting so near-identical shades collapse into one
 * entry — otherwise a smooth gradient would report dozens of one-pixel "dominant" colours instead
 * of the few that visually read as the clip's palette.
 */
export const dominantColours = (
  frames: readonly SampledFrame[],
  maxColours = DEFAULT_MAX_COLOURS,
): string[] => {
  const counts = new Map<
    string,
    { readonly b: number; count: number; readonly g: number; readonly r: number }
  >()

  for (const frame of frames) {
    const { data } = frame
    for (let i = 0; i + 3 < data.length; i += 4) {
      const r = bucket(data[i])
      const g = bucket(data[i + 1])
      const b = bucket(data[i + 2])
      const key = `${r},${g},${b}`
      const existing = counts.get(key)
      if (existing) {
        existing.count += 1
      } else {
        counts.set(key, { b, count: 1, g, r })
      }
    }
  }

  return [...counts.values()]
    .toSorted((a, b) => b.count - a.count)
    .slice(0, maxColours)
    .map((c) => `#${toHexByte(c.r)}${toHexByte(c.g)}${toHexByte(c.b)}`)
}

/**
 * Reads `canvas`'s current WebGL drawing buffer synchronously via `gl.readPixels`, for sampling a
 * frame *during* a live `requestAnimationFrame` render loop.
 *
 * This exists as a separate, synchronous alternative to `sampleFrame` because of a real, manually
 * confirmed failure mode (see the M2 task 4 report): a canvas with the (default)
 * `preserveDrawingBuffer: false` only reliably holds its just-drawn content for reads that happen
 * in the SAME synchronous turn as the draw call. `sampleFrame`'s `createImageBitmap` is
 * asynchronous — sampling through it from a `setTimeout` callback running between two animation
 * frames of an ongoing recording reads back all-zero pixels even though the canvas is visibly
 * rendering (confirmed: the recorded WebM itself contains correct frames throughout). Calling this
 * synchronously from inside the same `requestAnimationFrame` callback that just called
 * `compositor.tick()` avoids the gap entirely.
 */
export const readCanvasPixelsSync = (canvas: HTMLCanvasElement): SampledFrame => {
  const gl = canvas.getContext('webgl2') ?? canvas.getContext('webgl')
  if (!gl) {
    throw new Error('readCanvasPixelsSync: canvas has no WebGL context to read from.')
  }

  const { height, width } = canvas
  const data = new Uint8ClampedArray(width * height * 4)
  gl.readPixels(0, 0, width, height, gl.RGBA, gl.UNSIGNED_BYTE, data)
  return { data }
}

/**
 * Records `ms` milliseconds of `canvas`'s output as a WebM clip via `captureStream` +
 * `MediaRecorder` (spec §11). This needs a real `<canvas>` backed by a live render loop and a
 * browser's `MediaRecorder` implementation — it cannot run under a test runner and has no unit
 * test; see the M2 task 4 report for the manual evidence captured in its place.
 */
export const recordThumbnail = async (
  canvas: HTMLCanvasElement,
  ms: number,
  mimeType = 'video/webm',
): Promise<Blob> => {
  const stream = canvas.captureStream()
  const recorder = new MediaRecorder(stream, { mimeType })
  const chunks: Blob[] = []

  // `MediaRecorder` is a callback/event API with no promise-returning form — bridging it to
  // `await` requires a `Promise` executor. A deliberate, narrowly-scoped exception to the "no
  // `new Promise`" lint rule, isolated to this one call.
  // oxlint-disable-next-line promise/avoid-new
  return await new Promise<Blob>((resolve, reject) => {
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) {
        chunks.push(event.data)
      }
    })
    recorder.addEventListener('error', (event) => {
      reject(
        new Error(
          `recordThumbnail: MediaRecorder error (${event.message === '' ? event.type : event.message})`,
        ),
      )
    })
    recorder.addEventListener('stop', () => {
      resolve(new Blob(chunks, { type: mimeType }))
    })

    recorder.start()
    setTimeout(() => {
      recorder.stop()
    }, ms)
  })
}
