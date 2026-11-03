// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * The fixed tag vocabulary a clip may be annotated with.
 *
 * Fixed is the whole point. Asking a generative model "what tags describe this clip?" produces
 * "kaleid" one day and "kaleidoscopic" the next, and a library filtered on free text is a library
 * that quietly stops finding things. Each tag here is instead a single `noul` question — a
 * statement with criteria for true and for false — whose answer is a probability, and a clip's
 * tags are the ones that come back above `TAG_THRESHOLD` (`apps/app/src/ingest/tags.ts`).
 *
 * A tag therefore is NOT just a name: it is a statement jev can be asked about a clip's code, plus
 * a description of what makes that statement true and what makes it false. Writing those out is
 * what makes the vocabulary a question rather than a keyword list.
 *
 * Annotation reads a clip's CODE first and, when the browser uploaded them, a few rendered frames
 * beside it (ADR 0010). Spec §11 records the lesson that still frames lead to wrong judgements
 * about motion. Most statements below are about what the clip looks like, which both can show;
 * `strobe`, `pulsing`, `rotation` and `scrolling` are about change over time, so the brief tells
 * jev to judge anything that depends on movement from the code (`buildState`, `annotate.ts`).
 *
 * What is NOT here is as deliberate as what is. `feedback` and `audio-reactive` were in this list
 * and have been removed: `analyzeHydra` (`@vev/ingest`) already derives `deps.usesFeedback` and
 * `deps.usesAudio` from the clip's own source, deterministically, at registration. Asking a
 * probabilistic model the same question produces two answers to one question with no tiebreaker —
 * so those two tags are derived from `deps` instead, and jev is never asked.
 *
 * The vocabulary lives here rather than beside the annotator because it has a second reader: the
 * steering chat's tag dictionary (`@vev/decision`) must name the same tags, and a second copy of
 * eighteen statements is a second vocabulary waiting to drift.
 */
export interface TagDefinition {
  /** The stored tag, exactly as it appears in `Clip.tags` and in a `?tag=` filter. */
  readonly name: string
  /** The claim jev is asked to judge, phrased about the clip's rendered output. */
  readonly statement: string
  readonly whenFalse: string
  readonly whenTrue: string
}

/**
 * Eighteen tags describing what a Hydra sketch puts on screen (§5: "kaleidoscope", "noise",
 * "ascii", ...). The count is an UNMEASURED GUESS, exactly like `TAG_THRESHOLD` — it was twenty
 * until `feedback` and `audio-reactive` moved to derived tags, and nothing about eighteen has been
 * validated against a real library either.
 */
export const TAG_VOCABULARY: readonly TagDefinition[] = [
  {
    name: 'kaleidoscope',
    statement: 'The clip mirrors its image into a radial, kaleidoscopic pattern.',
    whenFalse: 'The image is not mirrored radially; whatever symmetry it has is not rotational.',
    whenTrue:
      'The output repeats a wedge of the image around a centre, as `kaleid` or a mirrored rotation does.',
  },
  {
    name: 'noise',
    statement: 'The clip is built mainly from procedural noise rather than from clean shapes.',
    whenFalse: 'The image comes from oscillators, gradients, solids or external sources, not from noise.',
    whenTrue: 'A noise or voronoi field is the dominant source of the image.',
  },
  {
    name: 'geometric',
    statement: 'The clip is dominated by hard-edged geometric forms.',
    whenFalse: 'Edges are soft, blurred or absent, and forms are irregular.',
    whenTrue: 'Shapes, grids, stripes or polygons with crisp edges make up most of the image.',
  },
  {
    name: 'organic',
    statement: 'The clip looks organic: flowing, irregular, biological rather than constructed.',
    whenFalse: 'Forms are rigid, regular or mechanical.',
    whenTrue: 'The image drifts and morphs in soft irregular ways, like smoke, liquid or tissue.',
  },
  {
    name: 'glitch',
    statement: 'The clip looks deliberately broken: tearing, displacement, channel separation.',
    whenFalse: 'The image is coherent, with no simulated corruption.',
    whenTrue: 'Slicing, sharp modulation or colour-channel offsets make the image read as corrupted signal.',
  },
  {
    name: 'monochrome',
    statement: 'The clip renders in a single hue or in greyscale.',
    whenFalse: 'Several distinct hues are present at once.',
    whenTrue: 'Colour is absent or restricted to one hue varying only in brightness.',
  },
  {
    name: 'saturated',
    statement: 'The clip uses intense, highly saturated colour.',
    whenFalse: 'Colours are muted, pastel, desaturated or dark.',
    whenTrue: 'Vivid colour at high saturation dominates the image.',
  },
  {
    name: 'gradient',
    statement: 'The clip is made largely of smooth gradients or colour ramps.',
    whenFalse: 'Colour changes abruptly, in flat regions or hard bands.',
    whenTrue: 'Colour blends continuously across the frame.',
  },
  {
    name: 'strobe',
    statement: 'The clip flashes or inverts fast enough to read as strobing.',
    whenFalse: 'Brightness changes gradually, or not at all.',
    whenTrue: 'Brightness or colour flips rapidly between extremes several times a second.',
  },
  {
    name: 'pulsing',
    statement: 'The clip pulses: something grows and shrinks, or brightens and dims, on a steady cycle.',
    whenFalse: 'Nothing in the image moves on a repeating cycle.',
    whenTrue: 'A periodic function drives scale, brightness or thickness in a visible rhythm.',
  },
  {
    name: 'rotation',
    statement: 'The clip rotates or spins.',
    whenFalse: 'Nothing turns about a point.',
    whenTrue: 'Part or all of the image turns continuously or back and forth about a centre.',
  },
  {
    name: 'scrolling',
    statement: 'The clip scrolls or drifts steadily in one direction.',
    whenFalse: 'The image stays put, or moves without a consistent direction.',
    whenTrue: 'Content translates continuously across the frame, often wrapping around.',
  },
  {
    name: 'distortion',
    statement: 'The clip warps or displaces its own image.',
    whenFalse: 'The image is drawn undistorted.',
    whenTrue: 'One source modulates another so the image bends, ripples or is pushed out of shape.',
  },
  {
    name: 'minimal',
    statement: 'The clip is visually minimal: few elements, large empty areas.',
    whenFalse: 'The frame is busy, layered or full of detail.',
    whenTrue: 'A small number of simple elements sit in mostly empty space.',
  },
  {
    name: 'psychedelic',
    statement: 'The clip reads as psychedelic: swirling, saturated, hallucinatory.',
    whenFalse: 'The image is restrained in colour or motion.',
    whenTrue: 'Intense colour cycling and swirling repetition combine into a hallucinatory image.',
  },
  {
    name: 'grid',
    statement: 'The clip repeats its content on a regular grid or tiling.',
    whenFalse: 'Content appears once, or repeats irregularly.',
    whenTrue: 'The image is tiled or repeated at regular intervals across the frame.',
  },
  {
    name: 'waveform',
    statement: 'The clip draws wave or line forms, such as an oscillating band or a stack of stripes.',
    whenFalse: 'The image is made of fields or areas rather than waves or lines.',
    whenTrue: 'Sine-driven bands, ripples or line stacks are the main visual element.',
  },
  {
    name: 'text',
    statement: 'The clip renders letters, digits or character glyphs.',
    whenFalse: 'No readable characters appear.',
    whenTrue: 'Text or character glyphs are drawn, whether legible words or an ASCII-style grid.',
  },
]
