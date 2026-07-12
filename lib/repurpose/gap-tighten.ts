// ===========================================================================
// REPURPOSE STUDIO -- gap tighten ("Shorten Word Gaps")
// ===========================================================================
// Descript's most-used everyday op, adapted for THIS project: pull the dead air
// off each kept take so the reel feels punchy without hand-trimming every clip
// edge. Surfaced as ONE inspector setting (`gapTightenSec`): the max silence to
// leave at each end of a take. Off = 0 = clips untouched.
//
// WHAT IT DOES
// ------------
// For every KEPT "take" clip, find the spoken words inside its span, then snap
// srcStart to `firstSpoken - maxGapSec` and srcEnd to `lastSpoken + maxGapSec`,
// leaving at most `maxGapSec` of head/tail breath. The timeline is DERIVED from
// srcEnd - srcStart, so a shorter span ripples the whole reel tighter for free.
//
// STATELESS + IDEMPOTENT (the reason this is safe under every other edit)
// ----------------------------------------------------------------------
// The store keeps ONE number and applies this pass live over the CURRENT clips.
// Edges are snapped to ABSOLUTE word times (firstSpoken/lastSpoken), NOT nudged
// relative to the current span -- so the pass may grow OR shrink an edge and
// re-running it with a different `maxGapSec` always lands the same edges for a
// given level. That means the slider is losslessly reversible (drag Off and
// every take is its full spoken span + a full breath again) and it composes on
// top of delete / trim / reorder / keeper-flip without a fragile parallel copy
// of the original cut.
//
// SAFETY BOUND: an edge is never grown past the HALFWAY point to the neighbor
// take's nearest word, so tightening can never pull a clip's edge into footage
// that belongs to an adjacent take (which would replay a word twice or leak a
// neighbor's audio). Silence and non-kept clips pass through untouched.
// ===========================================================================

import type { Clip, Word } from "./types";

/** Never shrink a take below ~1 frame -- guards a clip whose words are mistimed
 * from collapsing to a flash. */
const MIN_TAKE_SEC = 1 / 30;

/**
 * Return a copy of `clips` with each kept take tightened so it leaves at most
 * `maxGapSec` of silence at each end. Pure: never mutates the input.
 * `maxGapSec <= 0` (Off) returns the clips unchanged.
 *
 * @param clips  the current timeline clips, in timeline order.
 * @param words  the raw whole-recording transcript (source-time word timings).
 * @param maxGapSec  max silence to leave at each end of a take (e.g. 0.15 = 150ms).
 */
export function applyGapTighten(
  clips: Clip[],
  words: Word[],
  maxGapSec: number
): Clip[] {
  if (!(maxGapSec > 0) || words.length === 0) return clips;

  // Sorted spoken-word starts, for the neighbor-bound lookup below.
  const sortedWords = [...words].sort((a, b) => a.start - b.start);

  return clips.map((clip) => {
    if (!clip.kept || clip.kind !== "take") return clip;

    const inside = sortedWords.filter(
      (w) => w.start >= clip.srcStart && w.start < clip.srcEnd
    );
    if (inside.length === 0) return clip; // no speech to hug -- leave as cut

    const firstSpoken = inside[0].start;
    const lastSpoken = Math.max(...inside.map((w) => w.end));

    // Nearest spoken word OUTSIDE this clip on each side -- the halfway point to
    // it is the furthest an edge may grow so a breath never eats a neighbor take.
    const prevWord = sortedWords
      .filter((w) => w.end <= clip.srcStart)
      .reduce<Word | null>((best, w) => (!best || w.end > best.end ? w : best), null);
    const nextWord = sortedWords.find((w) => w.start >= clip.srcEnd) ?? null;

    const growFloor = prevWord ? (prevWord.end + firstSpoken) / 2 : 0;
    const growCeil = nextWord ? (nextWord.start + lastSpoken) / 2 : clip.srcEnd;

    let nextStart = Math.max(growFloor, firstSpoken - maxGapSec);
    let nextEnd = Math.min(growCeil, lastSpoken + maxGapSec);

    // Never let a snap invert or flatten the clip; fall back to the original span.
    if (nextEnd <= nextStart || nextEnd - nextStart < MIN_TAKE_SEC) return clip;

    if (nextStart === clip.srcStart && nextEnd === clip.srcEnd) return clip;

    return { ...clip, srcStart: nextStart, srcEnd: nextEnd };
  });
}
