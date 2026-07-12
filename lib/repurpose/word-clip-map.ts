// ===========================================================================
// REPURPOSE STUDIO -- word <-> clip mapping (transcript panel source of truth)
// ===========================================================================
// Contract file: pure logic over lib/repurpose/types.ts (Word/Clip) plus the
// forward/inverse time map (./time-map.ts). No DOM, no store, no Node APIs, so
// it runs in the browser transcript panel, the caption stream, and any Node
// script alike -- exactly like ./take-matcher.ts and ./time-map.ts.
//
// THE LOAD-BEARING FACT
// ---------------------
// `store.words` is the RAW WHOLE-RECORDING transcript (thousands of words --
// every retake, every "outside" bit that never made the short). `store.clips`
// is only the ~30-60s selectShort window. So MOST words map to NO kept clip.
// The transcript panel must therefore classify every word into one of three
// states, and it must render the in-short words in TIMELINE order (selectShort
// can place clips OUT of source order), NOT in raw source order.
//
// THREE WORD STATES
// -----------------
//   - "kept":    word.start falls inside some KEPT clip's source span ->
//                normal cream editable text.
//   - "deleted": the word's raw index is in the deleted set (an explicit user
//                intent, tracked by the store as `deletedWordIndices`) ->
//                strikethrough + dimmed, click to restore.
//   - "outside": no kept clip contains the word -- raw footage that never made
//                the short -> greyed, behind a collapsible "show full recording".
//
// A DELETED word wins over a KEPT hit: deletion is an explicit intent that the
// store realizes by soft-deleting a carrier clip AROUND the word span, so the
// forward cut may momentarily still report a kept clip over the word until the
// ripple settles -- the deleted set is the authority, so it is checked first.
//
// TIME-MAP MIRRORING (must stay byte-identical)
// ---------------------------------------------
// `clipForSourceTime` mirrors `sourceToTimelineTime`'s containment EXACTLY:
// half-open [srcStart, srcEnd) with `<` comparisons and NO epsilon, skipping
// zero/negative-width clips (srcEnd <= srcStart), returning the FIRST kept clip
// in timeline order. Any drift here (an added epsilon, a `<=`) would desync the
// transcript's notion of "which clip owns this word" from the exporter's notion
// of "which footage plays here", which is the whole bug this module prevents.
// ===========================================================================

import type { Clip, Word } from "./types";
import { sourceToTimelineTime } from "./time-map";

/** Which of the three transcript states a raw word is in. See module header. */
export type WordState = "kept" | "deleted" | "outside";

/**
 * A single classified transcript row -- one per RAW word index. The panel
 * renders these; `state` drives the styling, `clipId` links a kept/deleted word
 * back to its carrier clip (for selection / restore), and `timelineT` is where
 * the word lands on the OUTPUT timeline (null for "outside" words, which have no
 * place in the short) so kept/deleted rows can be sorted into timeline order.
 */
export interface WordView {
  index: number;
  word: Word;
  clipId: string | null;
  state: WordState;
  timelineT: number | null;
}

/**
 * First KEPT clip whose half-open source span [srcStart, srcEnd) contains `t`,
 * or null. Mirrors `sourceToTimelineTime`'s containment EXACTLY: `<` compares,
 * NO epsilon, zero/negative-width clips (srcEnd <= srcStart) skipped, first hit
 * in timeline order wins. Unlike the time map this returns the CLIP itself (the
 * panel needs its id), and it deliberately does NOT apply the closed-edge
 * end-clamp -- a word is "kept" only when a clip genuinely CONTAINS its start
 * time, never merely because its start equals some clip's out point.
 */
export function clipForSourceTime(clips: readonly Clip[], t: number): Clip | null {
  for (const clip of clips) {
    if (!clip.kept) continue;
    // Skip zero/negative-width clips, same guard as sourceToTimelineTime.
    if (clip.srcEnd <= clip.srcStart) continue;
    // Half-open [srcStart, srcEnd): `<` on the right edge, no epsilon.
    if (t >= clip.srcStart && t < clip.srcEnd) return clip;
  }
  return null;
}

/**
 * Classify EVERY raw word into a {@link WordView}, one row per word index, in
 * the ORIGINAL word-index order (stable -- the caller sorts/groups for display;
 * see {@link orderedForDisplay}).
 *
 * State resolution (order matters):
 *   1. `deletedSet.has(i)` -> "deleted" (explicit intent wins, see header).
 *   2. else a `clipForSourceTime` hit on `word.start` -> "kept".
 *   3. else -> "outside".
 *
 * `clipId` is the carrier clip's id for kept/deleted words that map into a clip,
 * else null. `timelineT` is `sourceToTimelineTime(clips, word.start)` -- null
 * for outside words (no kept clip owns them), and the exact output-timeline
 * position for in-short words, which is what drives timeline-ordered rendering.
 *
 * NOTE: a "deleted" word can still resolve a `clipId`/`timelineT` if a kept
 * carrier momentarily still overlaps it (pre-ripple); that is fine -- the state
 * is already "deleted", and having the timelineT lets the row sort into place
 * among its neighbors instead of jumping to the outside bucket.
 */
export function buildWordViews(
  words: readonly Word[],
  clips: readonly Clip[],
  deletedSet: ReadonlySet<number>
): WordView[] {
  const views: WordView[] = [];
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const hit = clipForSourceTime(clips, word.start);
    const timelineT = sourceToTimelineTime(clips, word.start);
    let state: WordState;
    if (deletedSet.has(i)) state = "deleted";
    else if (hit) state = "kept";
    else state = "outside";
    views.push({
      index: i,
      word,
      clipId: hit ? hit.id : null,
      state,
      timelineT,
    });
  }
  return views;
}

/**
 * Split classified views into the two render buckets and put the in-short bucket
 * into a stable TIMELINE order so a timeline-ordered render is trivial.
 *
 * - `outside`: every "outside" word, in original raw index order (the
 *   collapsible "show full recording" section renders these as-shot).
 * - `inShort`: every "kept" and "deleted" word, sorted by
 *   `(timelineT ?? Infinity)` then `index`. selectShort can place clips out of
 *   source order, so a raw-index sort would scramble the short -- sorting by
 *   `timelineT` reflows the words into the order they actually play. The `index`
 *   tie-break keeps the sort stable for words that share a timelineT (or the
 *   Infinity fallback for a deleted word whose carrier already collapsed).
 */
export function orderedForDisplay(views: WordView[]): {
  inShort: WordView[];
  outside: WordView[];
} {
  const inShort: WordView[] = [];
  const outside: WordView[] = [];
  for (const v of views) {
    if (v.state === "outside") outside.push(v);
    else inShort.push(v);
  }
  inShort.sort((a, b) => {
    const ta = a.timelineT ?? Infinity;
    const tb = b.timelineT ?? Infinity;
    if (ta !== tb) return ta - tb;
    return a.index - b.index;
  });
  return { inShort, outside };
}

/**
 * Merge a set of raw word indices into minimal contiguous SOURCE-time spans.
 *
 * Sorts the indices (order-independent input), then walks them merging each
 * word's [start, end) source interval into the current span when the next word
 * begins at or before the current span's end plus a tiny gap tolerance -- so a
 * run of adjacent words collapses into one span, while a jump to a distant word
 * (a non-contiguous selection) starts a fresh span. Uses the words' EXACT
 * start/end boundaries; the gap tolerance only bridges the sub-millisecond seam
 * transcribers leave between back-to-back words, never a real pause.
 *
 * Used by the store's word-delete path to turn a deleted word selection into
 * the minimal set of source spans to soft-delete a carrier clip around.
 */
export function coalesceWordSpans(
  words: readonly Word[],
  indices: readonly number[]
): { start: number; end: number }[] {
  if (indices.length === 0) return [];
  // Small seam tolerance: bridges the tiny gap transcribers leave between
  // consecutive words so "the" + "quick" merge, but never spans a real pause.
  const GAP = 0.02;
  const sorted = [...indices].sort((a, b) => a - b);
  const spans: { start: number; end: number }[] = [];
  let cur: { start: number; end: number } | null = null;
  for (const i of sorted) {
    const w = words[i];
    if (!w) continue; // defensive: ignore out-of-range indices
    if (cur && w.start <= cur.end + GAP) {
      // Contiguous (or overlapping) with the current span -- extend it.
      if (w.end > cur.end) cur.end = w.end;
    } else {
      // Gap too large (or first word) -- start a fresh span.
      cur = { start: w.start, end: w.end };
      spans.push(cur);
    }
  }
  return spans;
}
