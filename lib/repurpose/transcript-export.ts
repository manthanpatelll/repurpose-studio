// ===========================================================================
// REPURPOSE STUDIO -- transcript export (copy + .srt download)
// ===========================================================================
// Turns the CURRENT short (kept words only, in OUTPUT/timeline time, with any
// caption text edits applied) into shareable text:
//   - buildTranscriptSegments: kept words -> caption-sized segments in output
//     time. One walk, grouped on sentence punctuation / dead-air gaps / length.
//   - segmentsToTimestampedText: "[m:ss] line" per segment (clipboard copy).
//   - segmentsToSrt: standard numbered SRT blocks (HH:MM:SS,mmm).
//
// Words are mapped through the SAME forward map the exporter/preview use
// (buildWordViews -> sourceToTimelineTime), so timestamps here always match
// what the finished short actually plays. Deleted words and words outside any
// kept clip never appear.
// ===========================================================================

import type { Clip, Word } from "./types";
import { buildWordViews } from "./word-clip-map";
import type { CaptionBlock } from "./captions";

/**
 * captionBlocks -> Map of Math.round(word.start*1000) -> shown caption text,
 * ONLY where it differs from the raw word (a real textOverride). Keyed by
 * SOURCE start time because caption blocks store their own Word[] slices in
 * source seconds (the same key the store uses to reattach overrides), so the
 * map survives re-chunking. The ONE key scheme shared by the transcript rail
 * (edited-word underline) and the Copy/.srt output actions -- lives here so
 * the two consumers can never drift apart.
 */
export function buildOverrideByStartMs(
  blocks: readonly CaptionBlock[]
): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of blocks) {
    const ov = block.textOverride;
    if (!ov) continue;
    block.words.forEach((w, i) => {
      const shown = ov[i];
      if (shown != null && shown !== w.text) {
        map.set(Math.round(w.start * 1000), shown);
      }
    });
  }
  return map;
}

export interface TranscriptSegment {
  /** Output (timeline) time the segment starts at, seconds. */
  start: number;
  /** Output time the segment ends at, seconds. */
  end: number;
  /** The segment's text, edits applied, single-spaced. */
  text: string;
}

/** A word placed in output time, text override already applied. */
interface PlacedWord {
  text: string;
  start: number;
  end: number;
}

// Segment break tuning: a new segment starts after sentence-ending punctuation,
// after a dead-air gap you'd hear as a beat, or when a line grows past a
// caption-comfortable word count.
const GAP_BREAK_S = 0.8;
const MAX_WORDS_PER_SEGMENT = 14;
const SENTENCE_END = /[.!?]["')\]]?$/;

/**
 * Kept words -> ordered output-time segments.
 *
 * @param overrideByStartMs caption text edits keyed by Math.round(word.start*1000)
 *   -- the exact map WordTranscript already derives from captionBlocks.
 */
export function buildTranscriptSegments(
  words: readonly Word[],
  clips: readonly Clip[],
  deletedSet: ReadonlySet<number>,
  overrideByStartMs: ReadonlyMap<number, string>
): TranscriptSegment[] {
  const placed: PlacedWord[] = [];
  for (const view of buildWordViews(words, clips, deletedSet)) {
    if (view.state !== "kept" || view.timelineT == null) continue;
    const w = view.word;
    const text = overrideByStartMs.get(Math.round(w.start * 1000)) ?? w.text;
    if (!text.trim()) continue;
    placed.push({
      text: text.trim(),
      start: view.timelineT,
      end: view.timelineT + Math.max(0, w.end - w.start),
    });
  }

  const segments: TranscriptSegment[] = [];
  let current: PlacedWord[] = [];
  const flush = () => {
    if (current.length === 0) return;
    segments.push({
      start: current[0].start,
      end: current[current.length - 1].end,
      text: current.map((w) => w.text).join(" "),
    });
    current = [];
  };

  for (const w of placed) {
    const prev = current[current.length - 1];
    if (prev && w.start - prev.end > GAP_BREAK_S) flush();
    current.push(w);
    if (SENTENCE_END.test(w.text) || current.length >= MAX_WORDS_PER_SEGMENT) {
      flush();
    }
  }
  flush();
  return segments;
}

/** 83.4s -> "1:23" (minutes never padded -- reads like a video timestamp). */
function formatClock(t: number): string {
  const total = Math.max(0, Math.floor(t));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** 83.456s -> "00:01:23,456" (SRT's fixed-width timecode). */
function formatSrtTime(t: number): string {
  const clamped = Math.max(0, t);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/** Clipboard copy format: one "[m:ss] line" per segment. */
export function segmentsToTimestampedText(
  segments: readonly TranscriptSegment[]
): string {
  return segments
    .map((seg) => `[${formatClock(seg.start)}] ${seg.text}`)
    .join("\n");
}

/** Standard SRT: numbered blocks, "start --> end" timecodes, blank-line separated. */
export function segmentsToSrt(segments: readonly TranscriptSegment[]): string {
  return segments
    .map(
      (seg, i) =>
        `${i + 1}\n${formatSrtTime(seg.start)} --> ${formatSrtTime(seg.end)}\n${seg.text}`
    )
    .join("\n\n");
}
