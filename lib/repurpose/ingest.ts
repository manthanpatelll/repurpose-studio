// ===========================================================================
// REPURPOSE STUDIO -- footage/transcript ingest bridge
// ===========================================================================
// The missing link between the take-matching ENGINE (take-matcher.ts:
// matchTakes / detectSilences / buildClips) and the editor STORE
// (store.ts: setClips / setFootageMeta). Nothing else in the app called these
// together, so the timeline was permanently empty. This module runs the full
// pipeline in the browser from a loaded words.json (+ optional final
// transcript) and returns the Clip[] the store expects, plus a lightweight
// FootageMeta the PreviewCanvas can point its <video> elements at.
//
// Pure logic (no React, no store import) so it can be unit-tested and reused
// by a Node script; the TranscriptPanel wires its output into the store.
// ===========================================================================

import type { Clip, ClipTransition, FootageMeta, Word } from "./types";
import {
  matchTakes,
  detectSilences,
  buildClips,
  type Segment,
  type SilenceRange,
} from "./take-matcher";
import { selectShort, type ShortClip } from "./select-short";

/**
 * Default per-cut transition for a short reel. This is the WINDOW over which a
 * cut EASES the per-scene framing (screen pan/zoom, face framing, split ratio)
 * from the previous scene's values to this scene's -- see `screenFramingAt` /
 * `faceFramingAt` / `splitRatioAt` in ./time-map.ts. Crucially, easing only
 * shows when the two scenes' framings DIFFER: the resolvers no-op when
 * `from === target`, so an untouched auto-cut (both scenes framed as shot) still
 * reads as a clean instant cut. A scene Manthan reframes (drag/scroll) glides in
 * over this window. DESCRIPT-FEEL SMART TRANSITION: a SUBTLE settle, never a pop.
 * `amount: 0.025` means the incoming clip starts 2.5% larger and eases to normal
 * (compositor boost = 1 + amount*(1-e)), so every real cut gets a gentle "landed"
 * motion even when the two scenes share framing -- the smooth, natural feel of
 * Descript's Smart Transition, at a magnitude far below a zoom "pop". ~0.4s
 * natural (ease-in-out-cubic) matches Descript's soft default window. This is the
 * sweet spot Manthan asked for: feels like Descript, minimal work, no cross-blend
 * plumbing. Applied ONLY to a real source jump, never to a continuous same-take
 * join (see CONTINUOUS_TAKE_GAP) -- continuous speech stays a clean cut.
 */
export const DEFAULT_SMART_TRANSITION: ClipTransition = {
  type: "zoom-settle",
  durationSec: 0.4,
  amount: 0.025,
  easing: "natural",
};

/**
 * Two adjacent short clips whose source is within this many seconds are one take
 * the pipeline split (a caption boundary / rejoined line), NOT a scene change --
 * they must carry NO transition. A transition there is a forced pop on continuous
 * speech. Mirrors CUT_GAP in scripts/repurpose-fcpxml.mjs + fcpxml-import.ts.
 */
export const CONTINUOUS_TAKE_GAP = 0.4;

/** Shape of the `<base>.words.json` written by scripts/repurpose/transcribe-raw.mjs. */
export interface RawWordsFile {
  text: string;
  words: Word[];
}

/** Everything needed to assemble a Short's clip timeline from raw footage. */
export interface IngestInput {
  /** Raw face-cam word-level transcript (with retakes). */
  rawWords: Word[];
  /**
   * Clean FINAL transcript (published words, no retakes). When omitted, every
   * spoken span is kept as a single take (no retake detection) so the timeline
   * is still populated -- useful before a final transcript exists.
   */
  finalTranscript?: string;
}

/**
 * Run the take-matching pipeline and return the ordered Clip[] for the store.
 *
 * - With a final transcript: aligns raw retakes to the final lines, keeps the
 *   last (best) occurrence of each line, and auto-trims silences.
 * - Without one: falls back to one kept take spanning all raw words plus
 *   detected silences, so the editor still has a timeline to work from.
 */
export function buildClipsFromIngest(input: IngestInput): Clip[] {
  const { rawWords, finalTranscript } = input;
  if (rawWords.length === 0) return [];

  const silences = detectSilences(rawWords);

  if (finalTranscript && finalTranscript.trim().length > 0) {
    const segments = matchTakes(rawWords, finalTranscript);
    return buildClips(segments, silences);
  }

  // No final transcript -> single all-spanning take + detected silences.
  const first = rawWords[0];
  const last = rawWords[rawWords.length - 1];
  const fallbackSegment = {
    text: "Full take",
    srcStart: first.start,
    srcEnd: last.end,
    occurrenceCount: 1,
    keeperIndex: 0,
    occurrences: [{ start: first.start, end: last.end }],
  };
  return buildClips([fallbackSegment], silences);
}

/**
 * Build the SHORT-FORM REEL clip list (~30-60s), not the full-length assembly.
 *
 * buildClipsFromIngest keeps EVERY final-transcript line -- that's the whole
 * video with retakes removed (often many minutes), which is NOT a Reel. This
 * runs the same ingest, then selectShort to pick the self-contained
 * hook -> body -> CTA window, and returns ONLY those lines as the timeline's
 * Clip[]. This is what "Repurpose Studio" is for: a finished short, not the
 * long cut. setClips lays the returned clips out back-to-back (recomputeTimeline),
 * so the resulting timeline runtime is the Reel length.
 *
 * Falls back to the full assembly when there's no final transcript (nothing to
 * select from) or when selectShort finds no viable window (returns []), so the
 * editor is never left empty.
 */
/**
 * Convert selected ShortClips into kept take Clips. timelineStart/End are
 * derived by the store's recomputeTimeline, so we seed them at 0 here.
 * A cut gets the gentle default Smart transition ONLY on a real source jump
 * (Manthan: cuts must NOT pop/zoom -- just slightly ease to the next clip, and a
 * continuous same-take join should not transition at all). It's the INCOMING
 * motion, so the first clip (i === 0) gets none -- the reel's opening frame with
 * nothing before it. Deterministic (source-gap driven), so ripple/reorder never
 * shifts which cut has motion. Shared by buildShortClips and buildShortWithStats
 * so the two can never diverge.
 */
function shortClipsToClips(shortClips: ShortClip[]): Clip[] {
  return shortClips.map((sc, i) => ({
    id: `short-${i}`,
    kind: "take" as const,
    label: sc.text,
    srcStart: sc.srcStart,
    srcEnd: sc.srcEnd,
    timelineStart: 0,
    timelineEnd: 0,
    kept: true,
    isKeeperTake: false,
    occurrences: [{ start: sc.srcStart, end: sc.srcEnd }],
    keeperIndex: 0,
    // Ease ONLY on a real source jump. A continuous same-take join (the prev
    // clip ends within CONTINUOUS_TAKE_GAP of this one's start) gets NO
    // transition -- that continuous speech reads as one shot, never a pop.
    transitionIn:
      i > 0 && sc.srcStart - shortClips[i - 1].srcEnd > CONTINUOUS_TAKE_GAP + 1e-6
        ? DEFAULT_SMART_TRANSITION
        : undefined,
    // Seed the lineage id to the clip's own id: a fresh short clip is its own
    // origin. When a word-delete later splits this clip, the split pieces inherit
    // THIS originId, so Stage-3 auto-merge can recognize they came from one take.
    originId: `short-${i}`,
  }));
}

export function buildShortClips(input: IngestInput): Clip[] {
  const full = buildClipsFromIngest(input);
  if (full.length === 0) return full;

  const short = selectShort(full);
  if (short.clips.length === 0) return full; // no viable Reel window -> keep full cut

  return shortClipsToClips(short.clips);
}

/**
 * The auto-cut savings summary -- what the tool removed for you, surfaced in the
 * UI as "N retakes removed / M silences trimmed / X.Xs saved". Computed over the
 * SELECTED SHORT WINDOW only (not the whole raw recording), so the numbers match
 * the clips actually on the timeline. All derived from the same pipeline that
 * built those clips, so they can never drift from what shipped.
 */
export interface EditStats {
  /** Retake occurrences discarded across the short's kept lines (keeper excluded). */
  retakesRemoved: number;
  /** Silence gaps trimmed in the CONTIGUOUS dead air between consecutive kept lines. */
  silencesTrimmed: number;
  /**
   * Seconds of real dead air removed: the sum of small (contiguous) raw gaps
   * BETWEEN consecutive kept lines that the seamless cut swallowed. Clamped at
   * 0. Deliberately NOT (min..max span - runtime): the short's lines (e.g. a CTA
   * pulled from the end of a 40-min shoot) can be far apart in the raw footage,
   * and that distant footage was never going to be in the reel -- counting it
   * would inflate "saved" into meaningless tens-of-minutes numbers.
   */
  secondsSaved: number;
  /** Assembled short runtime, seconds (sum of kept clip durations). */
  finalRuntimeSec: number;
}

const clipDur = (c: { srcStart: number; srcEnd: number }): number =>
  Math.max(0, c.srcEnd - c.srcStart);

/**
 * Largest raw gap (seconds) between two consecutive kept lines that still counts
 * as CONTIGUOUS dead air the cut removed. A larger jump is a scene change / a
 * line pulled from a distant part of the shoot -- that footage was never reel
 * material, so its gap is NOT "time saved". Matches selectShort's contiguity
 * intent (its default maxContiguityGapSec) so the two agree on what "seamless"
 * means.
 */
const CONTIGUOUS_GAP_SEC = 8;

/**
 * Derive the savings summary for the selected short from the matcher segments,
 * detected silences, and the chosen short clips. Pure + deterministic.
 *
 * - retakesRemoved: for each short clip, find the segment whose KEEPER range
 *   matches it, and count its non-keeper occurrences (occurrences.length - 1).
 * - secondsSaved / silencesTrimmed: walk CONSECUTIVE kept clips; for each small
 *   (<= CONTIGUOUS_GAP_SEC) forward gap between them, add the gap to secondsSaved
 *   and count the silences that fall inside it. Big jumps (distant lines) are
 *   skipped -- that footage was never in the reel, so it isn't "saved".
 */
export function computeEditStats(
  segments: Segment[],
  silences: SilenceRange[],
  shortClips: ShortClip[]
): EditStats {
  const finalRuntimeSec = shortClips.reduce((sum, c) => sum + clipDur(c), 0);
  if (shortClips.length === 0) {
    return { retakesRemoved: 0, silencesTrimmed: 0, secondsSaved: 0, finalRuntimeSec: 0 };
  }

  const EPS = 1e-3;

  // Retakes: match each short clip to the segment whose keeper cut it, count the
  // discarded occurrences. Match on keeper srcStart ONLY, not srcStart+srcEnd:
  // buildClips rewrites a segment's srcEnd when it caps a GROSS stretch (a keeper
  // window that swallowed distant dead air), so a capped line's ShortClip srcEnd
  // no longer equals seg.srcEnd and a two-key match would miss it -- undercounting
  // "N retakes removed". srcStart is preserved through the cap (and through the
  // internal-silence split's first piece + selectShort's piece coalescing), so it
  // alone identifies the keeper. It is unique across matched segments too:
  // dedupeSourceOverlaps guarantees no two matched segments have overlapping
  // [srcStart, srcEnd] source ranges, so no two can share a srcStart.
  let retakesRemoved = 0;
  for (const sc of shortClips) {
    const seg = segments.find(
      (s) => s.occurrenceCount > 0 && Math.abs(s.srcStart - sc.srcStart) < EPS
    );
    if (seg) retakesRemoved += Math.max(0, seg.occurrences.length - 1);
  }

  // Dead air: only the small forward gaps BETWEEN consecutive kept clips (in the
  // order they appear in the reel). This is the footage the seamless cut removed.
  let secondsSaved = 0;
  let silencesTrimmed = 0;
  for (let i = 1; i < shortClips.length; i++) {
    const gapStart = shortClips[i - 1].srcEnd;
    const gapEnd = shortClips[i].srcStart;
    const gap = gapEnd - gapStart;
    if (gap <= EPS || gap > CONTIGUOUS_GAP_SEC) continue; // no gap, or a scene jump
    secondsSaved += gap;
    silencesTrimmed += silences.filter(
      (s) => s.start >= gapStart - EPS && s.end <= gapEnd + EPS
    ).length;
  }

  return {
    retakesRemoved,
    silencesTrimmed,
    secondsSaved: Math.max(0, secondsSaved),
    finalRuntimeSec,
  };
}

/**
 * Build the short's clips AND its savings summary in one pass, re-using the same
 * matcher run so the stats can never disagree with the timeline. Returns the
 * clips exactly as `buildShortClips` would, plus `stats` (null when there's no
 * final transcript or no viable window -- i.e. the full-cut fallback, where a
 * "short savings" number would be meaningless).
 */
export function buildShortWithStats(input: IngestInput): {
  clips: Clip[];
  stats: EditStats | null;
} {
  const { rawWords, finalTranscript } = input;
  if (rawWords.length === 0) return { clips: [], stats: null };

  // Only the aligned (final-transcript) path yields retake groups + a selectable
  // short window; the fallback path has neither, so no meaningful savings stat.
  if (!finalTranscript || finalTranscript.trim().length === 0) {
    return { clips: buildShortClips(input), stats: null };
  }

  const silences = detectSilences(rawWords);
  const segments = matchTakes(rawWords, finalTranscript);
  const full = buildClips(segments, silences);
  if (full.length === 0) return { clips: [], stats: null };

  const short = selectShort(full);
  if (short.clips.length === 0) {
    // No viable Reel window -> full-cut fallback; a "short savings" stat wouldn't
    // describe what's on the timeline, so leave it null.
    return { clips: buildShortClips(input), stats: null };
  }

  return {
    clips: shortClipsToClips(short.clips),
    stats: computeEditStats(segments, silences, short.clips),
  };
}

/**
 * Convert a footage source reference into something an HTML `<video>` can
 * actually load. A raw OS path (`/Users/.../clip.mp4`) is NOT loadable by a
 * browser -- assigning it to `<video>.src` yields a permanent gray frame. This
 * routes such a path through the local streaming API
 * (`/api/repurpose/video?path=...`), which serves the file with byte-range
 * support so `<video>` can decode and seek it.
 *
 * Already-loadable references pass through untouched:
 *   - `blob:` object URLs (from a file picker / drag-drop),
 *   - `http(s):` and protocol-relative URLs,
 *   - app-relative URLs (`/api/...`, `/repurpose/...`, other `public/` assets),
 *   - empty string (no source yet).
 */
export function footageUrlForPath(ref: string): string {
  if (ref === "") return ref;
  // blob:, data:, http:, https:, file: ... anything with a scheme, plus
  // protocol-relative (//host) and already-app-relative (/...) URLs.
  if (/^[a-z][a-z0-9+.-]*:/i.test(ref) || ref.startsWith("//") || ref.startsWith("/api/")) {
    return ref;
  }
  // Absolute OS path -> stream through the range-serving API route.
  if (ref.startsWith("/") || /^[A-Za-z]:[\\/]/.test(ref)) {
    // Distinguish a public-asset URL ("/repurpose/foo.mp4", which the browser
    // CAN load directly) from a raw filesystem path ("/Users/.../foo.mp4").
    // Only paths that look like real disk locations get proxied; short
    // app-root-relative URLs are served as-is by Next's static handler.
    const looksLikeOsPath =
      ref.startsWith("/Users/") ||
      ref.startsWith("/home/") ||
      ref.startsWith("/var/") ||
      ref.startsWith("/tmp/") ||
      ref.startsWith("/private/") ||
      /^[A-Za-z]:[\\/]/.test(ref);
    if (looksLikeOsPath) {
      return `/api/repurpose/video?path=${encodeURIComponent(ref)}`;
    }
  }
  return ref;
}

/**
 * Derive a FootageMeta from user-picked media plus the raw words. `durationSec`
 * defaults to the last word's end when a real media duration isn't known yet
 * (the <video> metadata load can refine it later).
 *
 * `faceCamPath`/`screenPath` accept EITHER a browser-loadable URL (blob: /
 * http: / app-relative) or a raw OS path; both are normalized through
 * `footageUrlForPath` so the stored values are always something `<video>.src`
 * can load. This is the single choke point that guarantees preview + export
 * never receive an unloadable `/Users/...` path.
 */
export function makeFootageMeta(params: {
  faceCamPath: string;
  screenPath: string;
  rawWords: Word[];
  fps?: number;
  width?: number;
  height?: number;
  durationSec?: number;
}): FootageMeta {
  const { faceCamPath, screenPath, rawWords } = params;
  const lastEnd = rawWords.length > 0 ? rawWords[rawWords.length - 1].end : 0;
  return {
    faceCamPath: footageUrlForPath(faceCamPath),
    screenPath: footageUrlForPath(screenPath),
    fps: params.fps ?? 30,
    width: params.width ?? 1920,
    height: params.height ?? 1080,
    durationSec: params.durationSec ?? lastEnd,
  };
}

/** Parse and validate a loaded words.json blob. Throws on malformed input. */
export function parseRawWordsFile(json: unknown): RawWordsFile {
  if (typeof json !== "object" || json === null) {
    throw new Error("words.json: expected a JSON object");
  }
  const obj = json as Record<string, unknown>;
  const words = obj.words;
  if (!Array.isArray(words)) {
    throw new Error("words.json: missing `words` array");
  }
  const parsed: Word[] = words.map((w, i) => {
    if (typeof w !== "object" || w === null) {
      throw new Error(`words.json: word ${i} is not an object`);
    }
    const rec = w as Record<string, unknown>;
    if (typeof rec.text !== "string" || typeof rec.start !== "number" || typeof rec.end !== "number") {
      throw new Error(`words.json: word ${i} missing text/start/end`);
    }
    return { text: rec.text, start: rec.start, end: rec.end };
  });
  return { text: typeof obj.text === "string" ? obj.text : "", words: parsed };
}
