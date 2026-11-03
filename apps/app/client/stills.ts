// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Stills: the few rendered frames annotation looks at beside a clip's code (ADR 0010).
 *
 * They are captured during the thumbnail recording and uploaded after registration. TypeSafe's
 * image input is beta and strict, so what leaves the browser is already inside its limits (PNG or
 * JPEG, 280-1568 pixels a side, 78,400-2,458,624 pixels in all). The registration canvas is
 * 320x180, below the 280-pixel side minimum — a frame sent as drawn is refused with "Invalid image
 * dimensions" — so every frame is resized, and sizing is a decision made here, tested, rather
 * than in the page.
 */

/** How many frames a clip gets. The API route caps the upload at the same number. */
export const STILL_COUNT = 3

const STILL_LONG_SIDE = 512
const MIN_SIDE = 280
const MAX_SIDE = 1568
const MIN_PIXELS = 78_400
const MAX_PIXELS = 2_458_624
const JPEG_QUALITY = 0.85

export interface StillSize {
  readonly height: number
  readonly width: number
}

/**
 * The size a `width` x `height` canvas is resized to: its long side becomes 512, enlarged further
 * only if that leaves the short side under 280. `undefined` when no size keeps the aspect ratio
 * inside the limits (an empty canvas, or a strip more than about 5.6:1), in which case the clip
 * simply has no stills.
 */
export const stillSize = (width: number, height: number): StillSize | undefined => {
  if (!(width > 0 && height > 0)) {
    return undefined
  }
  const scale = Math.max(STILL_LONG_SIDE / Math.max(width, height), MIN_SIDE / Math.min(width, height))
  const size = { height: Math.round(height * scale), width: Math.round(width * scale) }
  const inside =
    Math.min(size.width, size.height) >= MIN_SIDE &&
    Math.max(size.width, size.height) <= MAX_SIDE &&
    size.width * size.height >= MIN_PIXELS &&
    size.width * size.height <= MAX_PIXELS
  return inside ? size : undefined
}

/**
 * When, in milliseconds into a recording of `ms`, each still is taken: evenly spread and clear of
 * both ends, since the first frames of a recording are the clip warming up and the last are the
 * recorder stopping.
 */
export const stillMoments = (ms: number, count = STILL_COUNT): number[] =>
  Array.from({ length: count }, (_, index) => ((2 * index + 1) / (2 * count)) * ms)

/**
 * Copies `source`'s current frame onto a fresh 2D canvas of `size`. SYNCHRONOUS on purpose, for the
 * reason `readCanvasPixelsSync` (`palette.ts`) gives: a WebGL canvas with `preserveDrawingBuffer:
 * false` holds its pixels only until the draw's task ends, so this must run in the same
 * `requestAnimationFrame` callback that just ticked the compositor. Only the JPEG encoding that
 * follows (`encodeJpeg`) may be asynchronous, because by then the copy is a plain 2D canvas.
 */
export const snapshotCanvas = (source: HTMLCanvasElement, size: StillSize): HTMLCanvasElement => {
  const copy = document.createElement('canvas')
  copy.width = size.width
  copy.height = size.height
  const context = copy.getContext('2d')
  if (!context) {
    throw new Error('snapshotCanvas: no 2D context to copy the frame onto.')
  }
  context.drawImage(source, 0, 0, size.width, size.height)
  return copy
}

export const encodeJpeg = async (canvas: HTMLCanvasElement): Promise<Blob> =>
  // `toBlob` is callback-only. A narrowly-scoped exception to the "no `new Promise`" lint rule.
  // oxlint-disable-next-line promise/avoid-new
  await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob === null) {
          reject(new Error('encodeJpeg: the browser produced no image.'))
          return
        }
        resolve(blob)
      },
      'image/jpeg',
      JPEG_QUALITY,
    )
  })
