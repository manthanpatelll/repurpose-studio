// ===========================================================================
// REPURPOSE STUDIO -- take matcher
// ===========================================================================
// Contract file: builds on lib/repurpose/types.ts (Word/Clip). Pure logic,
// no DOM/Node APIs, so it can run in the browser (timeline UI) or in a Node
// script (scripts/repurpose/transcribe-raw.mjs).
//
// THE PROBLEM
// -----------
// Manthan records a raw face-cam with retakes: he says a line up to ~9
// times, the first N are bad, the LAST one is the keeper, then he moves on
// to the next line. He also has a clean FINAL transcript (the published
// words, no retakes -- e.g. pulled from the edited SRT). This module aligns
// the two: it walks the final transcript phrase by phrase, finds every place
// in the raw word stream that phrase (approximately) occurs, groups
// consecutive-ish occurrences as "retakes of the same line", and picks the
// LAST occurrence as the keeper.
//
// HEURISTIC (documented in detail on matchTakes below)
// -----------------------------------------------------
// 1. Split the final transcript into phrases (sentence-ish chunks).
// 2. For each phrase, slide a window across the raw words and score
//    normalized token similarity (case/punctuation-insensitive, Levenshtein-
//    ish overlap) against the phrase.
// 3. Collect all windows that clear a similarity threshold -- these are
//    "candidate occurrences" of that line, in the order they appear in the
//    raw footage (retakes are read in order, so no re-sorting needed).
// 4. Occurrences that are close together in time (within maxGapBetweenTakes)
//    are grouped into one Segment (a "take group"); a large gap means the
//    speaker moved on and came back later (still same line) -- group
//    separately by default, since that's much more likely a deliberate
//    re-recording later in the shoot than a retake of the same beat.
// 5. Within a group, the LAST occurrence is the keeper (keeperIndex).
// 6. Handles partial retakes (only half a line repeated) via a second,
//    directional "containment" score (what fraction of the CANDIDATE
//    window's tokens appear in the phrase) alongside the symmetric overlap
//    score -- a short, clean subset of a long phrase scores well on
//    containment even though it would score poorly on a naive symmetric
//    comparison (which penalizes length mismatches). The window search
//    considers lengths from ~1/3 of the phrase up to phrase+slack words so
//    both full and partial repeats are found as separate candidates, and a
//    greedy non-max-suppression pass (highest full-match score first)
//    resolves any overlapping candidates so one real take is never split
//    into two, nor two adjacent takes merged into one.
// 7. Filler between takes ("okay", "let me try that again", long pauses) is
//    naturally skipped: it does not match the phrase's tokens, so the
//    sliding window simply fails threshold on those words and they end up
//    attributed to neither occurrence (left as gap, later covered by
//    detectSilences or by the discarded-takes gaps in buildClips).
// ===========================================================================

import type { Clip, Word } from "./types";

export type { Word };

/** One detected line + its retake occurrences, with the keeper selected. */
export interface Segment {
  /** The phrase text (from the final transcript) this segment represents. */
  text: string;
  /** Start time (seconds, raw source) of the KEEPER occurrence. */
  srcStart: number;
  /** End time (seconds, raw source) of the KEEPER occurrence. */
  srcEnd: number;
  /** How many times this line was said in the raw footage (occurrences found). */
  occurrenceCount: number;
  /** Index (0-based, in chronological order) of the keeper among occurrences. */
  keeperIndex: number;
  /**
   * Every occurrence (retake) of this line in the raw footage, in chronological
   * order, as {start,end} source-time ranges. This is what lets the UI show a
   * Take 1 / Take 2 chooser and flip the keeper -- it must NOT be discarded by
   * the oneSegmentPerLine collapse.
   */
  occurrences: { start: number; end: number }[];
}

/** A trimmable gap between words -- silence longer than the threshold. */
export interface SilenceRange {
  start: number;
  end: number;
}

interface Occurrence {
  /** Index into rawWords of the first matched word. */
  wordStart: number;
  /** Index into rawWords of the last matched word (inclusive). */
  wordEnd: number;
  start: number;
  end: number;
  score: number;
}

interface MatchTakesOptions {
  /**
   * Minimum normalized token-overlap similarity (0..1) for a raw-word window
   * to count as an occurrence of a phrase. Default 0.6 -- tolerant of
   * transcription drift between takes (Whisper doesn't transcribe identically
   * every time even for the same words spoken the same way).
   */
  similarityThreshold?: number;
  /**
   * Occurrences of the same phrase more than this many seconds apart (raw
   * source time) are treated as separate take-groups rather than retakes of
   * one continuous attempt. Default 45s -- long enough to span "let me try
   * again" filler + a breath, short enough not to merge a genuinely
   * re-visited line much later in the shoot.
   */
  maxGapBetweenTakes?: number;
  /**
   * Extra search slack (in words) added to the phrase's own token count when
   * sizing the sliding window, to tolerate partial retakes / extra filler
   * words inside a take. Default 4.
   */
  windowSlack?: number;
  /**
   * When true (default), collapse multiple take-groups of the SAME final line
   * to the single best-scoring occurrence, so a phrase that recurs across a
   * long recording yields one clip, not one per recurrence. Set false to keep
   * every take-group (when the "final transcript" is itself a full multi-take
   * script rather than a clean per-short line list).
   */
  oneSegmentPerLine?: boolean;
  /**
   * Similarity threshold for the second-chance FALLBACK pass that runs ONLY
   * for a phrase the strict main pass matched nowhere. Lower than
   * `similarityThreshold` (default 0.6) so a line whose transcription drifted a
   * little between takes, or that was shadowed by an earlier near-duplicate
   * phrase, is still recovered rather than silently dropped. The fallback also
   * ignores prior claims and relaxes the window floor -- see matchTakes.
   */
  fallbackSimilarityThreshold?: number;
}

interface DetectSilencesOptions {
  /** Gaps shorter than this (seconds) are not considered silence. Default 0.7s. */
  thresholdSec?: number;
  /**
   * How much of the gap to leave in as a natural breath rather than trimming
   * it entirely, split evenly off both ends. Default 0.2s.
   */
  keepBreathSec?: number;
}

// ---------------------------------------------------------------------------
// Token normalization + similarity
// ---------------------------------------------------------------------------

/** Lowercases, strips punctuation, collapses whitespace -- for fuzzy matching. */
function normalizeToken(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[.,!?;:"'()\-–—]/g, "")
    .trim();
}

function tokenize(text: string): string[] {
  return text
    .split(/\s+/)
    .map(normalizeToken)
    .filter((t) => t.length > 0);
}

/**
 * Splits a clean transcript into phrase-ish chunks on SENTENCE boundaries
 * (./!/?) only. A whole spoken sentence is ONE phrase so that its retakes are
 * detected as a burst of that same sentence -- NOT fragmented into pieces that
 * each match separately.
 *
 * CRITICAL: we do NOT split on commas. Comma-splitting was the root cause of
 * the real-footage failure -- "Claude just drop routines, which is basically
 * their take on n8n or Zapier" became two 4-word fragments, so the 5x opening
 * retake read as occurrenceCount=1 per fragment and the last-take burst logic
 * never engaged. Matching the full sentence keeps each retake whole.
 *
 * maxWords is raised to 30 (a full spoken sentence) and only a genuine run-on
 * beyond that is hard-chunked as a last resort. Short chunks (<2 words) merge
 * into the previous phrase so a lone filler word never becomes its own phrase.
 */
function splitIntoPhrases(finalTranscript: string, maxWords = 30): string[] {
  const sentences = finalTranscript
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const phrases: string[] = [];
  for (const sentence of sentences) {
    const words = tokenize(sentence);
    if (words.length <= maxWords) {
      phrases.push(sentence);
      continue;
    }
    // Only a genuine run-on (>maxWords, no sentence break) is hard-chunked.
    // NOT comma-split -- see the note above. Chunk on word count directly so
    // each chunk is still a substantial span, not a 4-word fragment.
    const rawWords = sentence.split(/\s+/).filter(Boolean);
    for (let i = 0; i < rawWords.length; i += maxWords) {
      phrases.push(rawWords.slice(i, i + maxWords).join(" "));
    }
  }

  // Merge any too-short phrase into its predecessor so single filler words
  // never become their own phrase.
  const merged: string[] = [];
  for (const phrase of phrases) {
    if (tokenize(phrase).length < 2 && merged.length > 0) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} ${phrase}`.trim();
    } else {
      merged.push(phrase);
    }
  }
  return merged.filter((p) => tokenize(p).length > 0);
}

/**
 * Normalized token-overlap similarity in [0, 1] between two token arrays.
 * Uses a Sorensen-Dice-style coefficient over multisets so word order
 * mismatches from stutters/false starts don't zero out the score the way a
 * strict Levenshtein-on-strings comparison would, while duplicated words
 * still count against you (multiset, not a plain set).
 */
function tokenSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const countsA = new Map<string, number>();
  for (const t of a) countsA.set(t, (countsA.get(t) ?? 0) + 1);
  const countsB = new Map<string, number>();
  for (const t of b) countsB.set(t, (countsB.get(t) ?? 0) + 1);

  let overlap = 0;
  for (const [tok, countA] of countsA) {
    const countB = countsB.get(tok) ?? 0;
    overlap += Math.min(countA, countB);
  }
  return (2 * overlap) / (a.length + b.length);
}

/**
 * Directional containment score in [0, 1]: what fraction of `window`'s own
 * tokens are found in `phrase`. Unlike the symmetric tokenSimilarity above,
 * this does not get dragged down by `phrase` being much longer than
 * `window` -- which is exactly what happens for a PARTIAL retake (only the
 * back half of a line said again). A short, clean subset of the phrase
 * scores close to 1.0 here even though the phrase itself is long.
 */
function containmentScore(phraseTokens: string[], windowTokens: string[]): number {
  if (windowTokens.length === 0) return 0;
  const countsPhrase = new Map<string, number>();
  for (const t of phraseTokens) countsPhrase.set(t, (countsPhrase.get(t) ?? 0) + 1);
  const remaining = new Map(countsPhrase);
  let overlap = 0;
  for (const t of windowTokens) {
    const left = remaining.get(t) ?? 0;
    if (left > 0) {
      overlap += 1;
      remaining.set(t, left - 1);
    }
  }
  return overlap / windowTokens.length;
}

/**
 * Fraction of `windowTokens` that do NOT appear anywhere in the phrase's token
 * SET (identity, not multiset -- a repeated phrase word is still "in-set" for
 * every window copy). This is the window's "foreign token" load: how much of it
 * belongs to some OTHER line. Used as a scoring penalty so a window can't
 * silently swallow the first word(s) of the NEXT sentence and still clear
 * threshold -- the classic `windowSlack` over-run that pulled "Yes," (the start
 * of "Yes, yes.") onto the tail of "...but it's not." and produced a
 * cross-line source overlap. A window that is a clean subset/superset of the
 * phrase's own vocabulary scores 0 here (no penalty); a window padded with
 * unrelated trailing words is pushed back below threshold.
 */
function foreignTokenFraction(phraseTokenSet: Set<string>, windowTokens: string[]): number {
  if (windowTokens.length === 0) return 0;
  let foreign = 0;
  for (const t of windowTokens) if (!phraseTokenSet.has(t)) foreign += 1;
  return foreign / windowTokens.length;
}

/**
 * How hard each unit of "foreign token fraction" (words in a window that are
 * absent from the phrase's own vocabulary -- see foreignTokenFraction) is
 * subtracted from a window's match score before thresholding. Kept modest (0.5)
 * so a couple of stray filler words caught INSIDE an otherwise-clean long take
 * are still tolerated, while a short window padded with the NEXT sentence's
 * opening word is pushed below threshold and the window stays inside the
 * phrase's own tokens. This is the primary guard against the `windowSlack`
 * over-run that pulled a neighbor's first word into a keeper window.
 */
const FOREIGN_TOKEN_PENALTY = 0.5;

/**
 * Collects every raw-word window that clears `threshold` as a candidate
 * occurrence of `phraseTokens`. Factored out of matchTakes so the same scan
 * can run twice per phrase: a strict MAIN pass (respecting words already
 * claimed by earlier phrases, high threshold, half-phrase window floor) and,
 * only when that finds nothing, a lenient FALLBACK pass (lower threshold,
 * smaller window floor, optionally ignoring prior claims) that recovers a
 * final line which is verbatim-present in the raw but was fully shadowed by an
 * earlier near-duplicate phrase's claim -- so a real line is never silently
 * dropped. See the two call sites in matchTakes for the exact parameters.
 *
 * `respectClaims=false` lets the fallback reach into words a DISCARDED
 * take-group of an earlier phrase over-claimed (those words survive in
 * claimedGlobal even though oneSegmentPerLine threw that group's segment away),
 * which is the exact shadowing that dropped lines in the real-footage run.
 */
function collectCandidates(
  rawWords: Word[],
  rawTokens: string[],
  phraseTokens: string[],
  claimedGlobal: boolean[],
  minWindow: number,
  maxWindow: number,
  threshold: number,
  respectClaims: boolean
): Occurrence[] {
  const candidates: Occurrence[] = [];
  // Phrase vocabulary (identity set) for the foreign-token overrun penalty.
  const phraseTokenSet = new Set(phraseTokens);
  for (let start = 0; start < rawWords.length; start++) {
    if (respectClaims && claimedGlobal[start]) continue; // word already used by another phrase
    for (
      let windowLen = minWindow;
      windowLen <= maxWindow && start + windowLen <= rawWords.length;
      windowLen++
    ) {
      const end = start + windowLen; // exclusive
      // Skip any window that reaches into a word already claimed by an earlier
      // phrase -- those spans belong to a different line. (Only in the strict
      // pass; the fallback deliberately ignores claims to recover a shadowed
      // line.)
      if (respectClaims) {
        let hitsClaimed = false;
        for (let i = start; i < end; i++) {
          if (claimedGlobal[i]) {
            hitsClaimed = true;
            break;
          }
        }
        if (hitsClaimed) break; // longer windows from this start only reach further into claimed words
      }
      const windowTokens = rawTokens.slice(start, end);
      // Score is the BETTER of two metrics: tokenSimilarity (symmetric
      // overlap -- rewards a window that is a close FULL match to the
      // phrase) and containmentScore (what fraction of the window's own
      // tokens are found in the phrase -- rewards a short, clean SUBSET
      // of the phrase without being penalized just for being shorter
      // than the full line, which is exactly what a partial retake is).
      const symmetric = tokenSimilarity(phraseTokens, windowTokens);
      const containment = containmentScore(phraseTokens, windowTokens);
      // Penalize windows padded with words foreign to the phrase's own
      // vocabulary. A clean full/partial match has no foreign tokens (penalty
      // 0); a window that over-ran into the NEXT sentence's first word(s) --
      // the windowSlack over-run -- carries a foreign fraction and is pushed
      // back below threshold, so the window stops at the phrase's own tokens
      // instead of swallowing a neighbor's opening word. FOREIGN_TOKEN_PENALTY
      // weights how hard we punish each unit of foreign fraction; 0.5 is enough
      // that a single stray trailing word on a short window drops it under the
      // 0.78 strict threshold while a couple of stray fillers inside a long,
      // otherwise-clean take are still tolerated.
      const foreign = foreignTokenFraction(phraseTokenSet, windowTokens);
      const score = Math.max(symmetric, containment) - FOREIGN_TOKEN_PENALTY * foreign;
      if (score >= threshold) {
        candidates.push({
          wordStart: start,
          wordEnd: end - 1,
          start: rawWords[start].start,
          end: rawWords[end - 1].end,
          score: symmetric, // tie-break metric only: prefer fuller matches
        });
      }
    }
  }
  return candidates;
}

// ---------------------------------------------------------------------------
// matchTakes
// ---------------------------------------------------------------------------

/**
 * Aligns a raw face-cam word stream (with retakes) against a clean final
 * transcript (no retakes) and returns, for every line/phrase in the final
 * transcript, the KEEPER occurrence's in/out timestamps in the raw source.
 *
 * See the heuristic writeup at the top of this file for the full algorithm.
 * Phrases that cannot be matched anywhere in the raw footage above
 * `similarityThreshold` are still returned with `occurrenceCount: 0` and
 * `srcStart === srcEnd === -1` so callers can flag them for manual review
 * rather than silently dropping a line from the final cut.
 */
export function matchTakes(
  rawWords: Word[],
  finalTranscript: string,
  opts: MatchTakesOptions = {}
): Segment[] {
  const {
    // Raised from 0.6: a 4-token intro phrase would clear 0.6 against a dozen
    // unrelated "..., which is basically ..." lines across a 41-min raw. 0.78
    // demands a genuinely close match, killing those false positives.
    similarityThreshold = 0.78,
    // Shrunk from 45s to 6s: a real retake burst is said back-to-back within a
    // few seconds. 45s wrongly merged a 1:37 take with a 3:37 re-record into
    // one group, so the "keeper" was picked across two separate recordings.
    maxGapBetweenTakes = 6,
    windowSlack = 4,
    // Collapse multiple take-groups of the SAME final line down to one best
    // occurrence. On by default: a final-transcript line = one moment in the
    // short, so recurrences across a long recording must not each emit a clip.
    oneSegmentPerLine = true,
    // Second-chance threshold for a phrase the strict pass missed entirely.
    // 0.6 (vs the strict 0.78): tolerant enough to recover a verbatim line that
    // an earlier near-duplicate phrase shadowed, but still well clear of noise.
    fallbackSimilarityThreshold = 0.6,
  } = opts;

  if (rawWords.length === 0) return [];

  const rawTokens = rawWords.map((w) => normalizeToken(w.text));
  const phrases = splitIntoPhrases(finalTranscript);
  const segments: Segment[] = [];

  // Words already claimed by a previous phrase's accepted occurrences. Each
  // phrase scans the WHOLE raw stream (not just forward from the previous
  // keeper), skipping only windows that overlap an already-claimed word --
  // so a phrase spoken EARLIER in the raw footage than a preceding phrase
  // (out-of-script-order re-record) is still found instead of being a false
  // NO MATCH. The old monotonically-advancing `searchFrom` cursor assumed
  // final order == raw order, which does not hold for those re-records.
  const claimedGlobal: boolean[] = new Array(rawWords.length).fill(false);

  for (const phrase of phrases) {
    const phraseTokens = tokenize(phrase);
    if (phraseTokens.length === 0) continue;

    // Window length bounds: up to windowSlack longer than the phrase (to
    // absorb a couple of stray filler words caught inside a take), down to
    // either a third of the phrase's length or 3 tokens -- whichever is
    // larger -- so a PARTIAL retake (only the back/front half of a line
    // said again) is still considered as its own candidate window instead
    // of being too short to ever qualify.
    // Partial-retake floor. A window must be at least HALF the phrase's tokens
    // to count as a real partial re-record -- this rejects the 3-4 common-word
    // fragments ("which is basically") that otherwise match dozens of unrelated
    // spots across a 41-min raw and explode the segment count. Capped at the
    // phrase length (a short line matches as a whole), and never below 3 so a
    // genuinely short line is still findable.
    const minWindow = Math.max(3, Math.ceil(phraseTokens.length / 2));
    const maxWindow = phraseTokens.length + windowSlack;

    // MAIN PASS. Collect EVERY (start, windowLen) candidate window that clears
    // the similarity threshold. We deliberately do not stop at the first
    // qualifying start index per position -- a naive single left-to-right
    // scan can let a window drift across a take boundary (e.g. the tail of
    // one retake + the head of the next both partially match the phrase,
    // scoring just as high as either real occurrence alone) and silently
    // merge two distinct takes into one bogus "occurrence" spanning both.
    // Instead we gather all qualifying candidates and resolve overlaps
    // below by greedily keeping the highest-scoring, most complete window
    // first (interval-scheduling / non-max-suppression), which reliably
    // isolates each real take even when retakes sit close together.
    let candidates = collectCandidates(
      rawWords,
      rawTokens,
      phraseTokens,
      claimedGlobal,
      minWindow,
      maxWindow,
      similarityThreshold,
      /* respectClaims */ true
    );

    // FALLBACK PASS. When the strict pass matched this phrase NOWHERE, it is
    // almost always because an earlier NEAR-DUPLICATE phrase (Manthan re-words
    // the same beat: "With claude routines, you just type..." vs "But with
    // claude routines, we just describe...") claimed the overlapping raw words
    // first -- and, because oneSegmentPerLine collapses that earlier phrase to
    // one keeper, the shadowing claim survives while its extra take-group is
    // discarded. A very short line ("Yes, yes.") is likewise easily swallowed
    // by an adjacent phrase's window. Rather than drop a line that is verbatim
    // present in the raw, retry with (a) a lower threshold, (b) a smaller
    // window floor so a 2-3 word line can match at its true length, and (c)
    // claims IGNORED so we can recover the shadowed span. Only runs on a total
    // miss, so it cannot loosen matches the strict pass already resolved.
    if (candidates.length === 0) {
      const fallbackMinWindow = Math.max(2, Math.min(phraseTokens.length, minWindow));
      candidates = collectCandidates(
        rawWords,
        rawTokens,
        phraseTokens,
        claimedGlobal,
        fallbackMinWindow,
        maxWindow,
        fallbackSimilarityThreshold,
        /* respectClaims */ false
      );
    }

    // Greedily accept candidates highest-score-first, skipping any that
    // overlap a word index range already claimed by a higher-scoring
    // candidate. Ties broken toward the window closest to the phrase's own
    // token count (least slack -- prefers a clean full match over a
    // stretched one) and, failing that, toward the earlier occurrence.
    candidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aSlack = Math.abs(a.wordEnd - a.wordStart + 1 - phraseTokens.length);
      const bSlack = Math.abs(b.wordEnd - b.wordStart + 1 - phraseTokens.length);
      if (aSlack !== bSlack) return aSlack - bSlack;
      return a.wordStart - b.wordStart;
    });

    const claimed: boolean[] = new Array(rawWords.length).fill(false);
    const accepted: Occurrence[] = [];
    for (const cand of candidates) {
      let overlaps = false;
      for (let i = cand.wordStart; i <= cand.wordEnd; i++) {
        if (claimed[i]) {
          overlaps = true;
          break;
        }
      }
      if (overlaps) continue;
      for (let i = cand.wordStart; i <= cand.wordEnd; i++) claimed[i] = true;
      accepted.push(cand);
    }

    // Claim this phrase's accepted word ranges globally so a later phrase can
    // never re-match the same raw words, while still being free to match words
    // that sit BEFORE these (out-of-order re-records).
    for (const occ of accepted) {
      for (let i = occ.wordStart; i <= occ.wordEnd; i++) claimedGlobal[i] = true;
    }

    // Restore chronological order (the greedy accept loop above sorted by
    // score, not position) -- occurrences must read in raw-footage order so
    // "last occurrence" really means the last one spoken, and grouping by
    // time gap below is meaningful.
    const occurrences = accepted.sort((a, b) => a.wordStart - b.wordStart);

    if (occurrences.length === 0) {
      segments.push({
        text: phrase,
        srcStart: -1,
        srcEnd: -1,
        occurrenceCount: 0,
        keeperIndex: -1,
        occurrences: [],
      });
      continue;
    }

    // Group occurrences into take-groups by gap between consecutive hits.
    // Consecutive-ish occurrences (small gap = retakes of the same attempt)
    // stay in one group; a big gap starts a new group (the line was
    // revisited much later -- treat as a distinct segment so its own
    // keeper is picked independently rather than merging across the shoot).
    const groups: Occurrence[][] = [];
    for (const occ of occurrences) {
      const lastGroup = groups[groups.length - 1];
      const lastOcc = lastGroup?.[lastGroup.length - 1];
      if (lastOcc && occ.start - lastOcc.end <= maxGapBetweenTakes) {
        lastGroup.push(occ);
      } else {
        groups.push([occ]);
      }
    }

    // Emit one Segment per group. KEEPER = the LAST occurrence in the tight
    // retake burst -- UNLESS that last hit is a clearly worse match than an
    // earlier one in the same burst, in which case the best-matching hit wins.
    //
    // Why "last, with a quality guard": within a tight burst (occurrences a
    // few seconds apart -- see maxGapBetweenTakes) the creator re-says the
    // same line and nails it on the final try, so the last take is the clean
    // keeper (this is Manthan's actual workflow, and the synthetic retake +
    // partial-retake cases encode it). The guard exists because on a real
    // 41-min recording a burst can still end on a half-swallowed fragment; if
    // an earlier hit in the SAME burst matches the phrase materially better
    // (score higher by a clear margin), that fuller delivery is the keeper.
    const KEEPER_SCORE_MARGIN = 0.15;
    const groupSegments: { seg: Segment; keeperScore: number }[] = [];
    for (const group of groups) {
      let keeperIndex = group.length - 1; // default: last take
      const lastScore = group[keeperIndex].score;
      let bestIdx = keeperIndex;
      let bestScore = lastScore;
      for (let i = 0; i < group.length - 1; i++) {
        if (group[i].score > bestScore) {
          bestScore = group[i].score;
          bestIdx = i;
        }
      }
      // Only override the last take if an earlier hit is clearly better.
      if (bestScore - lastScore > KEEPER_SCORE_MARGIN) {
        keeperIndex = bestIdx;
      }
      const keeper = group[keeperIndex];
      groupSegments.push({
        keeperScore: keeper.score,
        seg: {
          text: phrase,
          srcStart: keeper.start,
          srcEnd: keeper.end,
          occurrenceCount: group.length,
          keeperIndex,
          // Carry EVERY take of this group so the UI can flip the keeper.
          occurrences: group.map((o) => ({ start: o.start, end: o.end })),
        },
      });
    }

    if (oneSegmentPerLine && groupSegments.length > 1) {
      // A line in the FINAL transcript is a single moment in the short. On a
      // full 41-min walkthrough the same phrase recurs many times (Manthan
      // re-explains a concept as he demos it), producing many separate
      // take-groups -- but the short needs exactly ONE occurrence of that
      // line. Collapse all groups for this phrase to the single best-scoring
      // keeper (its cleanest, fullest delivery anywhere in the raw). This is
      // what turns ~90 unique final lines into ~90 segments instead of the
      // 400+ that recurrence would otherwise emit. Set oneSegmentPerLine:false
      // to keep every recurrence (useful when the "final transcript" is itself
      // a full multi-take script rather than a clean per-short line list).
      // Pick the best group, but honor "last good take wins" on near-ties:
      // when two clean deliveries score within KEEPER_SCORE_MARGIN of each
      // other, prefer the LATER one (Manthan re-says a line and nails the final
      // attempt). Only a clearly higher score beats a later take. This fixes
      // the ordering miss the validation found ("first cloud routine" kept an
      // early take when cleaner later retakes existed).
      let best = groupSegments[0];
      for (const gs of groupSegments) {
        const clearlyBetter = gs.keeperScore - best.keeperScore > KEEPER_SCORE_MARGIN;
        const laterAndComparable =
          Math.abs(gs.keeperScore - best.keeperScore) <= KEEPER_SCORE_MARGIN &&
          gs.seg.srcStart > best.seg.srcStart;
        if (clearlyBetter || laterAndComparable) best = gs;
      }
      segments.push(best.seg);
    } else {
      for (const gs of groupSegments) segments.push(gs.seg);
    }
  }

  // STRICT-MODE DE-DUP. Every accepted span within a single phrase is already
  // non-overlapping (the greedy claim loop guarantees it), but two DIFFERENT
  // phrases can still land on source ranges that touch: the strict pass claims
  // per-phrase in isolation, and the FALLBACK pass (respectClaims=false)
  // deliberately ignores prior claims to recover a shadowed line -- so a short
  // fallback line ("Yes, yes.") can be matched on words the PREVIOUS phrase's
  // window already over-ran into ("...but it's not. Yes,"). Left as-is, the two
  // keeper ranges overlap and buildClips emits two kept take clips covering the
  // same ~0.3s of source, so that footage plays back twice. Zero-residual mode
  // forbids that: no output source-range may overlap another. Walk the matched
  // segments in source order and, on any overlap, trim the EARLIER segment's
  // trailing edge back to the later one's start (the overrun is virtually always
  // a trailing filler word latched onto the earlier line); if trimming would
  // invert the earlier segment, push the later segment's start forward instead
  // so neither range is destroyed, just declipped at the seam.
  dedupeSourceOverlaps(segments);

  return segments;
}

/**
 * A resolved segment shorter than this (seconds) is effectively empty: buildClips
 * would emit a 0-duration take and selectShort would silently drop it. When seam
 * resolution would collapse a segment below this floor we mark it unmatched
 * instead, so the line surfaces for manual review rather than vanishing.
 */
const MIN_SEGMENT_SEC = 0.02;

/**
 * In-place: guarantees no two MATCHED segments (occurrenceCount > 0, srcStart
 * >= 0) have overlapping [srcStart, srcEnd] source ranges, so the assembled
 * output can never play the same raw footage twice. Unmatched segments
 * (srcStart === -1) are ignored. Segments are processed in source order; each
 * overlap is resolved at the seam by trimming the earlier segment's tail back
 * to the later segment's start, falling back to advancing the later segment's
 * start when trimming would collapse the earlier range.
 *
 * Overlap is resolved against a running FRONTIER -- the already-kept segment with
 * the largest srcEnd seen so far -- not merely the immediate predecessor in
 * source order. Sorting by srcStart does NOT sort by srcEnd, so a short segment
 * can start after (and be fully nested inside) an EARLIER long segment while its
 * immediate predecessor is some third, shorter range that ended before it.
 * Comparing only to matched[i-1] would miss that nesting and leak an overlap
 * against the longer earlier segment; tracking the max-srcEnd frontier catches
 * every containment.
 */
function dedupeSourceOverlaps(segments: Segment[]): void {
  const matched = segments
    .filter((s) => s.occurrenceCount > 0 && s.srcStart >= 0)
    .sort((a, b) => a.srcStart - b.srcStart);

  if (matched.length === 0) return;

  // frontier = the kept segment covering the furthest-right source time so far.
  let frontier = matched[0];
  for (let i = 1; i < matched.length; i++) {
    const cur = matched[i];
    if (cur.srcStart >= frontier.srcEnd) {
      // No overlap with the frontier. Since matched is sorted by srcStart and the
      // frontier holds the max srcEnd, cur is also clear of every earlier segment,
      // and (reaching further right) becomes the new frontier.
      frontier = cur;
      continue;
    }
    // Overlap: [cur.srcStart, min(frontier.srcEnd, cur.srcEnd)]. Prefer trimming
    // the earlier (frontier) segment's trailing overrun back to cur.srcStart.
    if (cur.srcStart > frontier.srcStart) {
      frontier.srcEnd = cur.srcStart;
      // cur now sits entirely to the right of the trimmed frontier; whichever of
      // the two reaches further right is the frontier for the next segment.
      if (cur.srcEnd > frontier.srcEnd) frontier = cur;
    } else {
      // cur starts at/before the frontier (frontier fully contains cur's head) --
      // can't trim the frontier's tail without inverting it, so advance cur's
      // start past the frontier's end instead.
      const advancedStart = Math.min(frontier.srcEnd, cur.srcEnd);
      if (cur.srcEnd - advancedStart <= MIN_SEGMENT_SEC) {
        // Advancing collapses cur to (near) zero length. Rather than let it vanish
        // as a 0-duration take (which selectShort would silently drop, breaking
        // this module's "never silently drop a line" contract), mark it unmatched
        // so it surfaces for manual review. The frontier is unchanged -- it still
        // covers the source range cur was nested in.
        cur.srcStart = -1;
        cur.srcEnd = -1;
        cur.occurrenceCount = 0;
        cur.keeperIndex = -1;
        cur.occurrences = [];
      } else {
        cur.srcStart = advancedStart;
        if (cur.srcEnd > frontier.srcEnd) frontier = cur;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// detectSilences
// ---------------------------------------------------------------------------

/**
 * Finds gaps between consecutive words longer than `thresholdSec` (default
 * 700ms) -- these are candidate silences to auto-trim (dead air between
 * retakes, long pauses). Each returned range keeps a small breath
 * (`keepBreathSec`, split evenly off both ends) rather than trimming the
 * full gap, so cuts don't feel abrupt.
 */
export function detectSilences(
  words: Word[],
  opts: DetectSilencesOptions = {}
): SilenceRange[] {
  const { thresholdSec = 0.7, keepBreathSec = 0.2 } = opts;
  if (words.length < 2) return [];

  const silences: SilenceRange[] = [];
  const halfBreath = keepBreathSec / 2;

  for (let i = 0; i < words.length - 1; i++) {
    const gapStart = words[i].end;
    const gapEnd = words[i + 1].start;
    const gapDuration = gapEnd - gapStart;
    if (gapDuration <= thresholdSec) continue;

    const trimmedStart = gapStart + Math.min(halfBreath, gapDuration / 2);
    const trimmedEnd = gapEnd - Math.min(halfBreath, gapDuration / 2);
    if (trimmedEnd <= trimmedStart) continue;

    silences.push({ start: trimmedStart, end: trimmedEnd });
  }

  return silences;
}

// ---------------------------------------------------------------------------
// Internal-silence splitting (dead air INSIDE a kept take)
// ---------------------------------------------------------------------------

/**
 * A kept take's raw span carved into the parts that survive and the dead-air
 * parts trimmed out of the middle. `kept` sub-ranges are the spoken pieces
 * (played back-to-back in the output), `trimmed` sub-ranges are the internal
 * silences removed so they contribute ZERO runtime.
 */
interface SplitTake {
  kept: { start: number; end: number }[];
  trimmed: { start: number; end: number }[];
}

/**
 * Gaps inside a kept take's [srcStart, srcEnd] at least this long (seconds) are
 * treated as dead air and carved out of the take. A retake-burst gap is longer
 * than this and lives BETWEEN takes; this only fires on pauses that survived
 * INSIDE a single kept take (e.g. the creator narrating a slow on-screen action
 * with long silent stretches). 1.2s is comfortably above a natural breath
 * (detectSilences' 0.7s floor) so ordinary sentence-internal micro-pauses are
 * left in and delivery still feels natural.
 */
const INTERNAL_SILENCE_SPLIT_SEC = 1.2;

/**
 * After carving internal silences out of a take, any surviving spoken piece
 * shorter than this (seconds) is an ORPHAN -- a sub-word flash left when a
 * carved gap landed a fraction of a second from the take's edge (e.g. a take
 * whose last word sat 0.4s past a long internal pause). Emitting it as its own
 * timeline clip produces a single-frame-ish stutter in the assembled short. So
 * a piece below this floor is folded back into an adjacent kept piece by
 * absorbing the short trimmed gap that separates them (reclaiming the tiny
 * spoken fragment rather than dropping it); a lone orphan with no neighbor to
 * merge into is dropped outright. 0.5s is below any real spoken clause (even a
 * two-word tail runs longer at Manthan's pace) but safely above the sub-word
 * orphan flashes we want gone -- the real-footage run left 0.378s and 0.423s
 * tail pieces, both of which this floor folds back into their parent take.
 */
const MIN_PIECE_SEC = 0.5;

/**
 * Splits a take's raw source span around the detected silences that fall
 * INSIDE it, so long internal pauses (dead air the creator left mid-take while
 * an on-screen action played out) are removed from the assembled runtime
 * instead of being silently included in the kept clip.
 *
 * `silences` is the SAME detectSilences() output buildClips already receives --
 * each range there already has its natural breath left in (keepBreathSec), so a
 * carved gap keeps a little air on both sides and the recombined pieces don't
 * feel abruptly butt-spliced. Only silences whose (already breath-trimmed) span
 * is >= INTERNAL_SILENCE_SPLIT_SEC and that sit strictly inside (start, end)
 * are carved; anything shorter is left in as part of a kept piece so short
 * pauses survive.
 *
 * Returns the ordered kept spoken pieces and the trimmed dead-air spans. When
 * no qualifying internal silence exists the whole [start, end] comes back as a
 * single kept piece with no trimmed spans, i.e. the take is unchanged.
 */
function splitTakeAroundSilences(
  start: number,
  end: number,
  silences: SilenceRange[]
): SplitTake {
  // Internal silences: fully inside the take (not touching either boundary --
  // a gap that reaches the edge is a between-take gap, not dead air to carve),
  // and long enough to be worth cutting. Sorted so we walk left to right.
  const internal = silences
    .filter(
      (s) =>
        s.start > start &&
        s.end < end &&
        s.end - s.start >= INTERNAL_SILENCE_SPLIT_SEC
    )
    .sort((a, b) => a.start - b.start);

  if (internal.length === 0) {
    return { kept: [{ start, end }], trimmed: [] };
  }

  const kept: { start: number; end: number }[] = [];
  const trimmed: { start: number; end: number }[] = [];
  let cursor = start;
  for (const gap of internal) {
    // Skip a gap a previous (overlapping) gap already consumed past.
    if (gap.start <= cursor) {
      if (gap.end > cursor) cursor = gap.end;
      continue;
    }
    kept.push({ start: cursor, end: gap.start });
    trimmed.push({ start: gap.start, end: gap.end });
    cursor = gap.end;
  }
  if (cursor < end) kept.push({ start: cursor, end });

  return enforceMinPieceFloor(kept, trimmed);
}

/**
 * Enforces MIN_PIECE_SEC on the kept pieces coming out of splitTakeAroundSilences.
 * Invariant on input: `trimmed[i]` is the carved gap sitting BETWEEN `kept[i]`
 * and `kept[i+1]` (so trimmed.length === kept.length - 1 whenever any gap was
 * cut). Any kept piece shorter than the floor is an orphan flash; we fold it
 * into a neighbor by re-absorbing the short trimmed gap that separates them,
 * preferring whichever neighbor exists (later piece first, since a trailing
 * orphan is the common case). A single orphan with no neighbor is dropped. The
 * result never contains a sub-floor kept piece, and any trimmed gap that was
 * re-absorbed to bridge a merge is removed from `trimmed` so it is not also
 * reported as a silence in buildClips (which would double-count that span).
 */
function enforceMinPieceFloor(
  kept: { start: number; end: number }[],
  trimmed: { start: number; end: number }[]
): SplitTake {
  if (kept.length <= 1) return { kept, trimmed };

  const pieces = kept.map((p) => ({ ...p }));
  // Gaps aligned to the slot AFTER each piece: gapAfter[i] bridges pieces[i] and
  // pieces[i+1]. The last piece has no gap after it (null).
  const gapAfter: ({ start: number; end: number } | null)[] = pieces.map((_, i) =>
    i < trimmed.length ? { ...trimmed[i] } : null
  );
  const absorbed = new Set<{ start: number; end: number }>();

  let i = 0;
  while (i < pieces.length) {
    const dur = pieces[i].end - pieces[i].start;
    if (dur >= MIN_PIECE_SEC || pieces.length === 1) {
      i++;
      continue;
    }
    // Merge orphan pieces[i] into a neighbor by re-absorbing the bridging gap.
    if (i + 1 < pieces.length && gapAfter[i]) {
      // Fold forward into the next piece: [orphan.start .. next.end], gap gone.
      const gap = gapAfter[i]!;
      absorbed.add(gap);
      pieces[i + 1].start = pieces[i].start;
      pieces.splice(i, 1);
      gapAfter.splice(i, 1);
      // Re-check the merged (now larger) piece from the same index.
      continue;
    }
    if (i - 1 >= 0 && gapAfter[i - 1]) {
      // Fold backward into the previous piece: [prev.start .. orphan.end].
      const gap = gapAfter[i - 1]!;
      absorbed.add(gap);
      pieces[i - 1].end = pieces[i].end;
      pieces.splice(i, 1);
      gapAfter.splice(i - 1, 1);
      i = Math.max(0, i - 1);
      continue;
    }
    // Lone orphan, no bridgeable neighbor: drop it (its adjoining gap, if any,
    // stays trimmed -- the words were a sub-word flash not worth keeping).
    pieces.splice(i, 1);
    gapAfter.splice(i, 1);
  }

  const outTrimmed = trimmed.filter((t) => {
    for (const a of absorbed) if (a.start === t.start && a.end === t.end) return false;
    return true;
  });
  return { kept: pieces, trimmed: outTrimmed };
}

// ---------------------------------------------------------------------------
// buildClips
// ---------------------------------------------------------------------------

/**
 * Merges keeper Segments and detected SilenceRanges into the ordered Clip[]
 * the editor store (lib/repurpose/store.ts) expects: `take` clips for each
 * keeper occurrence (kept: true, isKeeperTake: true) and `silence` clips for
 * each trimmable gap (kept: false -- auto-trimmed, but left in the array so
 * the timeline UI can restore one if Manthan disagrees).
 *
 * Segments with no match (occurrenceCount === 0, srcStart === -1) are
 * skipped -- there's no raw footage span to place on the timeline for them;
 * callers should surface those separately for manual review (see the
 * console warning in scripts/repurpose/transcribe-raw.mjs).
 *
 * Silences that fall inside a kept take's span (rare -- mid-sentence
 * micro-pauses shorter than a full retake gap wouldn't reach here, but
 * defensively skip any overlap) are dropped so we never double-cover the
 * same source range with two clips.
 *
 * `timelineStart`/`timelineEnd` are computed once here (ripple from 0 over
 * kept clips in source order) -- the store's own `recomputeTimeline` will
 * re-derive them again on any subsequent edit, so this is just a sane
 * initial layout.
 */
export function buildClips(segments: Segment[], silences: SilenceRange[]): Clip[] {
  const matched = segments.filter((s) => s.occurrenceCount > 0 && s.srcStart >= 0);

  type Draft = {
    kind: "take" | "silence";
    label: string;
    srcStart: number;
    srcEnd: number;
    kept: boolean;
    isKeeperTake: boolean;
    /** All retakes of this line (first piece only) -- powers the Take chooser. */
    occurrences: { start: number; end: number }[];
    /** Which occurrence is the current keeper. */
    keeperIndex: number;
  };

  const drafts: Draft[] = [];

  // Internal dead-air spans carved OUT of kept takes (see splitTakeAroundSilences
  // below). Collected here so they can be emitted as kept:false silence markers
  // -- they overlap their parent take's raw span, so the between-take silence
  // loop further down drops them; adding them explicitly is what surfaces them
  // in the "N silences trimmed" stat without ever counting toward runtime.
  const internalTrimmed: { start: number; end: number }[] = [];

  // Takes are emitted in FINAL-TRANSCRIPT order (the order `segments` arrived),
  // NOT raw source order. On a recording full of retakes a line's keeper can
  // sit anywhere in the raw timeline, so sorting by srcStart would play the
  // short's sentences out of sequence (the real-footage validation found 23
  // such inversions). The `segments` array already carries final-script order,
  // so we preserve it.
  // Speaking-rate sanity: a natural clip runs ~2-4 words/sec, and normal takes
  // include pauses. We only intervene on GROSS stretches -- the validation
  // found a ~4s line spanning 58.9s (the window's last word recurred much later
  // and the span swallowed ~55s of dead air). Cap only when a clip is more than
  // GROSS_FACTOR x its plausible speaking time AND absolutely long (>12s), so
  // ordinary clips with generous pauses are never touched. When capped, the end
  // is pulled to a generous 1 word/sec bound -- enough for any real delivery,
  // far short of the dead-air region.
  const GROSS_FACTOR = 3;
  const GROSS_ABS_SEC = 12;
  for (const seg of matched) {
    const wordCount = seg.text.split(/\s+/).filter(Boolean).length;
    const plausibleDur = Math.max(1.5, wordCount / 2); // ~2 wps
    const rawDur = seg.srcEnd - seg.srcStart;
    const isGrossStretch =
      rawDur > GROSS_ABS_SEC && rawDur > plausibleDur * GROSS_FACTOR;
    const srcEnd = isGrossStretch
      ? seg.srcStart + Math.max(plausibleDur, wordCount) // 1 wps generous cap
      : seg.srcEnd;

    // Carve any long internal silence out of the (post-cap) span so a take that
    // holds big mid-delivery pauses -- one real take was 72% dead air -- no
    // longer drags that dead air into the assembled runtime. The take becomes
    // one kept clip per spoken piece (contiguous around each trimmed gap). The
    // FIRST piece carries the retake keeper flag and the original label; later
    // pieces are the same delivery continued, labelled with a piece index and
    // NOT flagged as keeper siblings, so the store's per-label keeper toggle
    // (setKeeperTake) never treats the continuation pieces as competing retakes.
    const { kept: pieces, trimmed } = splitTakeAroundSilences(
      seg.srcStart,
      srcEnd,
      silences
    );
    for (const t of trimmed) internalTrimmed.push(t);
    pieces.forEach((piece, pieceIndex) => {
      drafts.push({
        kind: "take",
        label:
          pieces.length > 1 ? `${seg.text} (${pieceIndex + 1})` : seg.text,
        srcStart: piece.start,
        srcEnd: piece.end,
        kept: true,
        isKeeperTake: pieceIndex === 0 && seg.occurrenceCount > 1,
        // Only the FIRST piece owns the retake alternatives (a continuation
        // piece is the same delivery split around an internal pause, not a
        // separate take the user would flip).
        occurrences: pieceIndex === 0 ? seg.occurrences : [],
        keeperIndex: pieceIndex === 0 ? seg.keeperIndex : -1,
      });
    });
  }

  // Silences are emitted as kept:false markers (0 timeline duration) so the UI
  // can show "N silences trimmed" without them ever adding dead air to the cut.
  // They are appended AFTER the ordered takes and sorted among themselves by
  // raw position -- they never interleave into the take order (which is final-
  // script order), so a raw-time gap can't inject a pause at the wrong spot.
  const silenceDrafts: Draft[] = [];
  for (const silence of silences) {
    const overlapsTake = matched.some(
      (seg) => silence.start < seg.srcEnd && silence.end > seg.srcStart
    );
    if (overlapsTake) continue;
    silenceDrafts.push({
      kind: "silence",
      label: "silence",
      srcStart: silence.start,
      srcEnd: silence.end,
      kept: false,
      isKeeperTake: false,
      occurrences: [],
      keeperIndex: -1,
    });
  }
  // Internal dead-air carved out of kept takes above: emit as kept:false markers
  // too. These overlap their parent take (so the loop above skipped them), but
  // they were physically removed from the take's kept pieces, so counting them
  // here as trimmed silence is correct -- not a double-cover of live footage.
  for (const gap of internalTrimmed) {
    silenceDrafts.push({
      kind: "silence",
      label: "silence",
      srcStart: gap.start,
      srcEnd: gap.end,
      kept: false,
      isKeeperTake: false,
      occurrences: [],
      keeperIndex: -1,
    });
  }
  silenceDrafts.sort((a, b) => a.srcStart - b.srcStart);
  drafts.push(...silenceDrafts);

  let cursor = 0;
  const clips: Clip[] = drafts.map((draft, index) => {
    const duration = Math.max(0, draft.srcEnd - draft.srcStart);
    const timelineStart = cursor;
    const timelineEnd = draft.kept ? cursor + duration : cursor;
    if (draft.kept) cursor = timelineEnd;
    return {
      id: `clip-${index}-${Math.round(draft.srcStart * 1000)}`,
      kind: draft.kind,
      label: draft.label,
      srcStart: draft.srcStart,
      srcEnd: draft.srcEnd,
      timelineStart,
      timelineEnd,
      kept: draft.kept,
      isKeeperTake: draft.isKeeperTake,
      occurrences: draft.occurrences,
      keeperIndex: draft.keeperIndex,
    };
  });

  return clips;
}
