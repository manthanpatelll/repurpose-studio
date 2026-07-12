// ===========================================================================
// REPURPOSE STUDIO -- SFX placement planner
// ===========================================================================
// The /soundeffects skill's "intelligence" -- deciding WHICH sound lands on
// WHICH beat -- is normally done by Claude reading a Whisper transcript and
// hand-authoring a list of {sfx, at_ms} events. This module is the deterministic
// CODE port of those rules, so the Repurpose Studio "Sound Effects" button can
// generate a track one-click without a chat round-trip.
//
// TIME MODEL. `Word.start/end` are SOURCE seconds. The reel is a re-cut /
// reordered assembly, so every placement MUST be authored against OUTPUT time
// (the assembled short), never raw source time. We map each surviving word to
// its output time via `sourceToTimelineTime(clips, word.start)` -- the exact
// forward map the compositor + audio assembler use -- so a placed effect fires
// over the same frames the viewer sees. Cut boundaries come from each kept
// clip's `timelineStart` (already output time).
//
// DIVISION OF LABOR (see the plan): this TS module decides WHICH effect goes
// WHERE (output-ms). The Python engine (`scripts/sfx-engine/build_sfx_track.py`)
// is the "dumb renderer" that turns those events into a WAV, owning gain / onset
// / peak-normalize (click 50% / whoosh-family 30% / else 20%). We do NOT
// duplicate gain here -- only placement.
//
// The rules mirror scripts/.claude SKILL.md (SFX Library table + Rules):
//   - digital_readout ("textdigitalreadout.wav") is Manthan's signature -- 8-10
//     per track, min 7s gap, spread evenly, on tech/stat/reveal beats.
//   - whoosh-family on scene-cut boundaries (topic/scene changes).
//   - keyword -> effect for click / keyboard / ding / impact / riser /
//     notification / camera_shutter / etc.
//   - min 1.5s gap between ANY two effects, max ~35-50 total.
//   - denser first 60s ONLY for long videos (>3-4min); reels stay even.
// ===========================================================================

import type { Clip, Word } from "./types";
import { sourceToTimelineTime } from "./time-map";

/** One placed sound effect: which library key, at what OUTPUT time (ms). */
export interface SfxEvent {
  /** Library key in build_sfx_track.py's SFX_LIBRARY (e.g. "digital_readout"). */
  sfx: string;
  /** Placement on the OUTPUT timeline, milliseconds. */
  atMs: number;
}

// Global spacing floor between ANY two placed effects (SKILL.md: min 1.5s gap).
const MIN_GAP_MS = 1500;
// digital_readout is never back-to-back; spread evenly (SKILL.md: min 7s gap).
const MIN_DR_GAP_MS = 7000;
// Signature-sound target count per track (SKILL.md: 8-10 digital readouts).
const DR_TARGET = 9;
// Upper bound on total placements so a long reel never turns into a wall of SFX.
const MAX_TOTAL = 50;
// Videos longer than this get a slightly denser 0-60s hook (SKILL.md rule).
const LONG_VIDEO_SEC = 200; // ~3.3 min

// ---------------------------------------------------------------------------
// Keyword -> effect map. Lifted from SKILL.md's SFX Library "Use For" column.
// Matched against a normalized (lowercased, punctuation-stripped) word token.
// Order matters only for readability; each word tries every rule and takes the
// first hit. digital_readout is handled SEPARATELY (even-spread, not keyword)
// so it isn't in this table.
// ---------------------------------------------------------------------------
const KEYWORD_RULES: { sfx: string; words: string[] }[] = [
  { sfx: "mouse_click", words: ["click", "select", "choose", "pick", "tap"] },
  { sfx: "keyboard", words: ["type", "typing", "write", "code", "coding", "command", "prompt", "enter"] },
  { sfx: "ding", words: ["perfect", "done", "success", "correct", "exactly", "boom", "nice", "yes"] },
  { sfx: "impact", words: ["not", "never", "wrong", "stop", "huge", "massive", "crazy", "insane"] },
  { sfx: "riser", words: ["power", "level", "unlock", "build", "grow", "scale", "boost", "next"] },
  { sfx: "notification", words: ["claude", "gpt", "cursor", "zapier", "notion", "slack", "tool", "app", "alert", "ping"] },
  { sfx: "camera_shutter", words: ["screenshot", "capture", "snap", "look", "watch", "show"] },
  { sfx: "digital_shutter", words: ["screen", "record", "recording", "frame"] },
  { sfx: "gear_shift", words: ["switch", "mode", "workflow", "handoff", "automate", "automation"] },
  { sfx: "gun_reload", words: ["ready", "locked", "loading", "load", "set"] },
  { sfx: "radio_beep", words: ["incoming", "connect", "connected", "live", "signal"] },
  { sfx: "air_hit", words: ["go", "start", "first", "now", "action"] },
  { sfx: "double_click", words: ["step", "then", "next", "second", "third", "finally"] },
];

// Words that read as a topic/scene change -- these bias toward a whoosh at the
// nearest cut, and seed the digital_readout beats (tech/stat/reveal language).
const DR_BIAS_WORDS = new Set([
  "claude", "ai", "automation", "workflow", "data", "api", "code", "system",
  "agent", "model", "prompt", "context", "output", "result", "results", "number",
  "percent", "x", "times", "faster", "hours", "minutes", "seconds", "days",
]);

/** Normalize a word token for matching: lowercase + strip non-alphanumerics. */
function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Whoosh family rotated across cuts so consecutive scene changes vary. */
const CUT_WHOOSHES = ["whoosh", "slide_whoosh", "blade_whoosh"] as const;

/**
 * A word mapped into output time, carrying its normalized token. Only words that
 * a kept clip actually shows survive (sourceToTimelineTime returns non-null).
 */
interface OutputWord {
  atMs: number;
  token: string;
  raw: string;
}

/**
 * Plan a full SFX track for the assembled reel. Deterministic + pure: same
 * (words, clips, duration) always yields the same event list, so re-clicking the
 * button after an edit re-plans identically for the unchanged parts.
 *
 * @param words    the raw transcript words (SOURCE time).
 * @param clips    the reel's clips (drives source->output mapping + cut beats).
 * @param durationSec the reel's output duration (seconds).
 * @returns events sorted ascending by `atMs`, each honoring the spacing rules.
 */
export function planSfxEvents(
  words: readonly Word[],
  clips: readonly Clip[],
  durationSec: number
): SfxEvent[] {
  const durationMs = Math.max(0, Math.round(durationSec * 1000));
  if (durationMs <= 0) return [];

  // 1. Project every surviving word into output time (drop trimmed-away words).
  const outWords: OutputWord[] = [];
  for (const w of words) {
    const outT = sourceToTimelineTime(clips, w.start);
    if (outT === null) continue;
    const atMs = Math.round(outT * 1000);
    if (atMs < 0 || atMs > durationMs) continue;
    outWords.push({ atMs, token: norm(w.text), raw: w.text });
  }
  outWords.sort((a, b) => a.atMs - b.atMs);

  // A running list of every committed placement time, used to enforce the global
  // 1.5s floor across ALL effect families at once. Kept sorted by insertion at
  // ascending output time (we place cuts, then keywords, then digital readouts,
  // each already time-ordered, and re-sort defensively before returning).
  const placed: SfxEvent[] = [];
  const placedTimes: number[] = [];

  /** True if `atMs` is at least `gapMs` from every already-placed effect. */
  function fits(atMs: number, gapMs: number): boolean {
    for (const t of placedTimes) {
      if (Math.abs(t - atMs) < gapMs) return false;
    }
    return true;
  }
  function commit(sfx: string, atMs: number): void {
    placed.push({ sfx, atMs });
    placedTimes.push(atMs);
  }

  // 2. Whoosh on scene-cut boundaries (topic/scene changes). Skip the very first
  // cut at t=0 (the reel open needs no transition whoosh). Rotate the whoosh
  // variant so back-to-back cuts don't sound identical.
  const cutTimes = clips
    .filter((c) => c.kept && c.timelineStart > 0.05)
    .map((c) => Math.round(c.timelineStart * 1000))
    .sort((a, b) => a - b);
  let whooshIdx = 0;
  for (const atMs of cutTimes) {
    if (atMs > durationMs) continue;
    if (!fits(atMs, MIN_GAP_MS)) continue;
    commit(CUT_WHOOSHES[whooshIdx % CUT_WHOOSHES.length], atMs);
    whooshIdx++;
  }

  // 3. Keyword-driven contextual effects. Walk output words in order; the first
  // matching rule wins, subject to the global 1.5s floor. digital_readout is
  // NOT placed here (step 4 owns its even spread).
  for (const ow of outWords) {
    if (placed.length >= MAX_TOTAL) break;
    if (!ow.token) continue;
    let chosen: string | null = null;
    for (const rule of KEYWORD_RULES) {
      if (rule.words.includes(ow.token)) {
        chosen = rule.sfx;
        break;
      }
    }
    if (!chosen) continue;
    if (!fits(ow.atMs, MIN_GAP_MS)) continue;
    commit(chosen, ow.atMs);
  }

  // 4. digital_readout -- Manthan's signature. Aim for ~9 evenly spread across
  // the reel, biased toward tech/stat/reveal beats, min 7s apart from each other
  // AND 1.5s from any other effect. Strategy: build candidate slots at even
  // intervals, then snap each to the nearest DR-bias word (or keep the even slot
  // if none is close), committing only those that satisfy both gaps.
  const drCandidates = pickDigitalReadoutTimes(outWords, durationMs);
  let drPlaced = 0;
  for (const atMs of drCandidates) {
    if (drPlaced >= DR_TARGET) break;
    if (placed.length >= MAX_TOTAL) break;
    // Must clear the DR-to-DR 7s gap and the global 1.5s floor.
    const drGapOk = placed
      .filter((p) => p.sfx === "digital_readout")
      .every((p) => Math.abs(p.atMs - atMs) >= MIN_DR_GAP_MS);
    if (!drGapOk) continue;
    if (!fits(atMs, MIN_GAP_MS)) continue;
    commit("digital_readout", atMs);
    drPlaced++;
  }

  // 5. Denser first-60s hook for LONG videos only (reels stay even). If the reel
  // is long and the opening minute is sparse, back-fill a couple of extra
  // digital readouts / dings in 0-60s respecting the same gaps.
  if (durationSec > LONG_VIDEO_SEC) {
    backfillOpeningHook(outWords, placed, placedTimes, commit, fits);
  }

  placed.sort((a, b) => a.atMs - b.atMs);
  return placed;
}

/**
 * Even-interval candidate times for digital_readout, each snapped to the nearest
 * DR-bias word within a window (so a readout lands on "automation"/"faster"/a
 * number rather than mid-sentence). Falls back to the bare even slot when no bias
 * word is near. Returns more candidates than DR_TARGET so the caller can skip
 * ones that fail the gap checks and still hit the target.
 */
function pickDigitalReadoutTimes(
  outWords: readonly OutputWord[],
  durationMs: number
): number[] {
  // Oversample slots (1.6x target) so gap-rejected slots still leave enough.
  const slots = Math.max(DR_TARGET, Math.round(DR_TARGET * 1.6));
  const interval = durationMs / (slots + 1);
  const biasWords = outWords.filter((w) => DR_BIAS_WORDS.has(w.token));
  const SNAP_WINDOW_MS = Math.min(2500, interval / 2);

  const out: number[] = [];
  for (let i = 1; i <= slots; i++) {
    const slotMs = Math.round(interval * i);
    // Nearest bias word within the snap window, else the bare slot.
    let best = slotMs;
    let bestDist = SNAP_WINDOW_MS + 1;
    for (const bw of biasWords) {
      const d = Math.abs(bw.atMs - slotMs);
      if (d < bestDist) {
        bestDist = d;
        best = bw.atMs;
      }
    }
    out.push(best);
  }
  // Dedupe (two slots may snap to the same word) + keep ascending.
  return [...new Set(out)].sort((a, b) => a - b);
}

/**
 * Long-video only: nudge the opening minute slightly denser to hook viewers.
 * Adds up to two extra digital readouts in 0-60s at bias words that clear the
 * gaps. Never crammed -- still honors MIN_DR_GAP_MS + MIN_GAP_MS.
 */
function backfillOpeningHook(
  outWords: readonly OutputWord[],
  placed: SfxEvent[],
  _placedTimes: number[],
  commit: (sfx: string, atMs: number) => void,
  fits: (atMs: number, gapMs: number) => boolean
): void {
  let added = 0;
  for (const ow of outWords) {
    if (added >= 2) break;
    if (ow.atMs > 60000) break;
    if (!DR_BIAS_WORDS.has(ow.token)) continue;
    const drGapOk = placed
      .filter((p) => p.sfx === "digital_readout")
      .every((p) => Math.abs(p.atMs - ow.atMs) >= MIN_DR_GAP_MS);
    if (!drGapOk) continue;
    if (!fits(ow.atMs, MIN_GAP_MS)) continue;
    commit("digital_readout", ow.atMs);
    added++;
  }
}
