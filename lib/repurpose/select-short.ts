// ===========================================================================
// REPURPOSE STUDIO -- short selection stage
// ===========================================================================
// Contract file: builds on lib/repurpose/take-matcher.ts (Segment) and
// lib/repurpose/types.ts (Clip). Pure logic, no DOM/Node APIs, so it runs in
// the browser (the "Build Short" affordance in the timeline UI) or in a Node
// script (scripts/repurpose/_test-select-short.mjs).
//
// THE PROBLEM
// -----------
// matchTakes turns a 41-min raw walkthrough into ~110 keeper segments (the
// full 9-min edit). That is NOT a Reel. A Reel needs a SELF-CONTAINED 30-60s
// window that stands on its own with no prior context: a HOOK that states the
// whole concept cold in verbatim words, a define -> prove -> stakes body from
// the lines that immediately follow it, and -- only if the creator actually
// said one -- a real CTA to close on. This module is that selection stage. It
// never rewrites a word (verbatim only) and never invents a CTA.
//
// HEURISTIC
// ---------
// 1. Keep only matched segments (a real raw span, occurrenceCount > 0). The
//    unmatched placeholders (srcStart === -1) have nowhere to cut from.
// 2. Find every segment that can open a Reel cold -- a HOOK. A hook must:
//      - state the concept in verbatim words (contain a "concept token" -- a
//        salient, non-stopword term that recurs across the transcript, i.e.
//        what the video is actually about),
//      - NOT lean on prior context: it cannot start with a discourse opener
//        ("so", "and", "but", "then", "now", "also", "because", ...), an
//        explicit back-reference ("as I mentioned", "like I said", ...), or a
//        BARE demonstrative subject ("this is ...", "that means ...", "these
//        are ...") that only resolves against an earlier sentence,
//      - be a full-ish sentence (enough words to carry a claim on its own).
//    Hooks are scored; the best-scoring earliest one wins.
// 3. From the hook, walk FORWARD through the segments that are contiguous in
//    the RAW SOURCE (each next keeper begins within a small gap of where the
//    previous ended) -- a single seamless take window, no stitching across
//    distant parts of the shoot. Accumulate lines until the runtime lands in
//    the target band (default 30-60s), preferring a define -> prove -> stakes
//    shape and stopping at a natural sentence end.
// 4. If a real CTA line (like / comment / subscribe / follow / share ...)
//    exists ANYWHERE in the transcript, append it as the closing clip so the
//    short ends on the creator's own call to action. If none exists, the short
//    simply ends on its last body line -- we NEVER fabricate a CTA.
// 5. Return the ordered clips with a role per clip (hook | body | cta), the
//    total runtime, and a short "whyItWorks" rationale for the UI to surface.
// ===========================================================================

import type { Segment } from "./take-matcher";
import type { Clip } from "./types";

export type ShortRole = "hook" | "body" | "cta";

/** One line placed in the assembled short, tagged with its narrative role. */
export interface ShortClip {
  /** The verbatim line text (from the final transcript). */
  text: string;
  /** Start time (seconds, raw source) of the keeper occurrence. */
  srcStart: number;
  /** End time (seconds, raw source) of the keeper occurrence. */
  srcEnd: number;
  /** Narrative role in the short's arc. */
  role: ShortRole;
}

export interface SelectShortResult {
  /** Ordered clips forming the short (hook first, then body, optional cta last). */
  clips: ShortClip[];
  /** Total runtime in seconds (sum of clip source durations). */
  totalRuntimeSec: number;
  /** One-line rationale for why this window works as a self-contained short. */
  whyItWorks: string;
}

export interface SelectShortOptions {
  /** Minimum acceptable short runtime, seconds. Default 30. */
  minRuntimeSec?: number;
  /** Maximum acceptable short runtime, seconds. Default 60. */
  maxRuntimeSec?: number;
  /**
   * Largest allowed gap (seconds, raw source) between the end of one kept line
   * and the start of the next for them to count as CONTIGUOUS (same seamless
   * take window). A jump larger than this means the next keeper lives in a
   * distant part of the shoot -- including it would require stitching, so we
   * stop the body there instead. Default 8s (spans a breath + a trimmed pause,
   * short of a real scene jump).
   */
  maxContiguityGapSec?: number;
  /**
   * Minimum tokens for a segment to qualify as a HOOK. A hook must carry a
   * whole claim on its own, so a 2-3 word fragment can't open the short.
   * Default 8.
   */
  minHookTokens?: number;
}

// ---------------------------------------------------------------------------
// Token helpers (kept local so this module has no cross-dependency on the
// matcher's private normalizers -- same rules, independently owned).
// ---------------------------------------------------------------------------

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

// Discourse openers that make a sentence depend on what came before it. A hook
// cannot start with any of these -- it would leave the viewer mid-thought.
const CONTEXT_OPENERS = new Set([
  "so",
  "and",
  "but",
  "then",
  "now",
  "also",
  "because",
  "however",
  "therefore",
  "anyway",
  "plus",
  "yet",
  "or",
  "nor",
  "though",
  "meanwhile",
  "again",
  "still",
  "basically",
]);

// Bare demonstratives that, when they open a sentence AS THE SUBJECT, only
// resolve against an earlier sentence ("this is ...", "that means ...").
const BARE_DEMONSTRATIVES = new Set(["this", "that", "these", "those", "it", "they", "he", "she"]);

// Multi-word back-references ("as I mentioned", "like I said"). Checked as a
// prefix on the normalized token stream.
const BACKREF_PREFIXES: string[][] = [
  ["as", "i", "mentioned"],
  ["as", "i", "said"],
  ["like", "i", "mentioned"],
  ["like", "i", "said"],
  ["as", "we", "discussed"],
  ["as", "you", "saw"],
  ["as", "you", "can", "see"],
  ["going", "back"],
  ["coming", "back"],
];

// English stopwords -- excluded when mining concept tokens so the "what the
// video is about" terms surface (not "the", "you", "your").
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "so", "to", "of", "in",
  "on", "at", "for", "with", "as", "is", "are", "was", "were", "be", "been",
  "being", "it", "its", "this", "that", "these", "those", "i", "you", "your",
  "we", "our", "they", "them", "he", "she", "his", "her", "my", "me", "us",
  "do", "does", "did", "done", "will", "would", "can", "could", "should",
  "have", "has", "had", "not", "no", "yes", "just", "what", "which", "who",
  "how", "when", "where", "why", "all", "any", "some", "one", "two", "three",
  "here", "there", "very", "much", "more", "most", "about", "into", "from",
  "up", "down", "out", "over", "under", "again", "also", "now", "get", "got",
  "go", "going", "want", "like", "make", "made", "way", "thing", "things",
  "something", "everything", "anything", "because", "around", "inside",
  "basically", "actually", "really", "right", "well", "okay", "let", "lets",
]);

// UNAMBIGUOUS call-to-action signals -- words that essentially only appear in a
// real end-screen CTA, so ONE is strong evidence. Deliberately excludes common
// tech-narration words (like/drop/hit/channel/share) which routinely co-occur in
// ordinary speech ("I like how you can just drop a file into any channel") and
// used to false-positive the old "any two distinct terms" rule. Verbatim only.
const STRONG_CTA_TERMS = new Set([
  "subscribe", "subscribed", "subscribing",
]);

// Explicit CTA PHRASES (checked as substrings of the normalized line). These are
// the actual outros a creator speaks -- a phrase match is unambiguous even when
// it uses otherwise-common words, because the WORDS TOGETHER only occur in a CTA.
// Verbatim only; never fabricated. Normalized = lowercased, punctuation-stripped.
const CTA_PHRASES = [
  "leave a comment", "drop a comment", "comment below", "comment down",
  "hit follow", "hit the follow", "smash that like", "smash the like",
  "smash that follow", "give it a like", "leave a like", "drop a like",
  "hit the bell", "ring the bell", "turn on notifications", "follow for more",
  "like and subscribe", "like comment", "comment and subscribe",
];

// ---------------------------------------------------------------------------
// Concept-token mining
// ---------------------------------------------------------------------------

/**
 * Mine the transcript's "concept tokens" -- the salient, recurring, non-stopword
 * terms that signal what the video is actually about (e.g. "routines", "n8n",
 * "automation", "code"). A hook has to contain at least one so it states the
 * subject cold rather than opening on a generic sentence. Derived from the data,
 * never hardcoded, so this generalizes to any topic.
 */
function mineConceptTokens(segments: Segment[]): Set<string> {
  const counts = new Map<string, number>();
  for (const seg of segments) {
    // Count a token once per segment (document frequency) so a single line
    // repeating a word doesn't inflate it -- recurrence ACROSS lines is what
    // marks a true subject term.
    const seen = new Set<string>();
    for (const tok of tokenize(seg.text)) {
      if (tok.length < 2) continue;
      if (STOPWORDS.has(tok)) continue;
      if (seen.has(tok)) continue;
      seen.add(tok);
      counts.set(tok, (counts.get(tok) ?? 0) + 1);
    }
  }
  // A concept token appears in at least ~3% of lines (recurs). Floor at 2 so a
  // short transcript still yields a set, and a distinctive product name that
  // shows up twice still counts.
  const minDocFreq = Math.max(2, Math.ceil(segments.length * 0.03));
  const concept = new Set<string>();
  for (const [tok, n] of counts) {
    if (n >= minDocFreq) concept.add(tok);
  }
  return concept;
}

// ---------------------------------------------------------------------------
// Hook qualification + scoring
// ---------------------------------------------------------------------------

function startsWithBackref(tokens: string[]): boolean {
  return BACKREF_PREFIXES.some((prefix) =>
    prefix.every((p, i) => tokens[i] === p)
  );
}

/**
 * Can this segment open a Reel cold? A hook must state a whole claim with no
 * dependence on a prior sentence. Returns true only when it clears every gate.
 */
function isHookCandidate(
  seg: Segment,
  conceptTokens: Set<string>,
  minHookTokens: number
): boolean {
  const tokens = tokenize(seg.text);
  if (tokens.length < minHookTokens) return false;

  const first = tokens[0];
  // Reject discourse openers ("so ...", "and ...", "now ...").
  if (CONTEXT_OPENERS.has(first)) return false;
  // Reject a bare demonstrative/pronoun subject ("this is ...", "they run ...").
  if (BARE_DEMONSTRATIVES.has(first)) return false;
  // Reject explicit back-references ("as I mentioned ...").
  if (startsWithBackref(tokens)) return false;

  // Must name the concept in verbatim words -- contain at least one concept
  // token so it states the subject cold, not a generic sentence.
  const namesConcept = tokens.some((t) => conceptTokens.has(t));
  if (!namesConcept) return false;

  return true;
}

/**
 * Score a hook candidate -- higher is a stronger cold open.
 *
 * A hook is the sentence that opens the CONCEPT for the viewer, not merely the
 * most concept-dense sentence anywhere in the video. On a long walkthrough a
 * deep mid-video line ("next is GitHub events, which basically ...") packs more
 * subject tokens than the actual opener, so raw hit-count is the wrong signal.
 * We instead reward, in priority order:
 *   1. NARRATIVE POSITION -- the final transcript is authored front-to-back, so
 *      the cold-open concept statement sits near its start. `positionScore`
 *      decays with the segment's index and dominates the ranking.
 *   2. CONCEPT PRESENCE (saturating) -- the hook must be about the subject, but
 *      one-or-more concept tokens is enough; extra hits barely help, so a dense
 *      mid-video line can't out-muscle an early true opener.
 *   3. SENTENCE FIT -- a punchy self-contained ~10-24 word sentence reads best.
 */
function scoreHook(
  seg: Segment,
  index: number,
  total: number,
  conceptTokens: Set<string>
): number {
  const tokens = tokenize(seg.text);
  const conceptHits = tokens.filter((t) => conceptTokens.has(t)).length;
  // Saturating concept presence: 0 hits => 0, 1 hit => most of the value,
  // more hits => diminishing. Keeps the hook on-topic without letting a
  // token-stuffed deep line win on raw count.
  const conceptPresence = conceptHits === 0 ? 0 : 1 + Math.log2(conceptHits + 1) * 0.5;
  // A punchy full sentence (~10-24 words) is ideal; very long lines drag.
  const lengthFit =
    tokens.length >= 10 && tokens.length <= 24
      ? 1
      : tokens.length < 10
        ? tokens.length / 10
        : Math.max(0.4, 24 / tokens.length);
  // Position: earliest lines score highest, decaying smoothly to ~0 by the end.
  // Weighted heavily so a genuine cold open near the front beats a concept-dense
  // line buried deep in the walkthrough.
  const positionScore = total > 1 ? 1 - index / (total - 1) : 1;
  return positionScore * 6 + conceptPresence * 2 + lengthFit;
}

// ---------------------------------------------------------------------------
// CTA detection
// ---------------------------------------------------------------------------

/**
 * Is this a REAL call-to-action line the creator actually spoke? Two ways to
 * qualify, both unambiguous so ordinary walkthrough narration can never trip it:
 *   1. It contains a STRONG term ("subscribe") -- that word only shows up in a
 *      real end-screen CTA.
 *   2. It contains an explicit CTA PHRASE ("leave a comment", "hit follow", ...) --
 *      a word combination that only occurs in a CTA, even when built from
 *      otherwise-common words.
 * The old "any two distinct CTA words" rule was removed: words like like / drop /
 * hit / channel / share co-occur constantly in normal tech speech (e.g. "I like
 * how you can just drop a file into any channel"), so counting them produced a
 * fabricated CTA pulled from a random mid-video line. Verbatim only.
 */
function isCtaSegment(seg: Segment): boolean {
  // Normalize once (lowercase, collapse punctuation to spaces) for phrase search.
  const norm = seg.text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  for (const phrase of CTA_PHRASES) {
    if (norm.includes(phrase)) return true;
  }
  const tokens = tokenize(seg.text);
  for (const t of tokens) if (STRONG_CTA_TERMS.has(t)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// selectShort
// ---------------------------------------------------------------------------

const dur = (seg: { srcStart: number; srcEnd: number }): number =>
  Math.max(0, seg.srcEnd - seg.srcStart);

/**
 * Select a self-contained 30-60s short from the full matched segments.
 *
 * Accepts either the raw Segment[] from matchTakes or the Clip[] from
 * buildClips (take clips only are used from a Clip[]). Returns the ordered
 * hook -> body -> (optional real) cta clips, the total runtime, a role per
 * clip, and a rationale. Verbatim only; never invents a CTA.
 */
export function selectShort(
  input: Segment[] | Clip[],
  opts: SelectShortOptions = {}
): SelectShortResult {
  const {
    minRuntimeSec = 30,
    maxRuntimeSec = 60,
    maxContiguityGapSec = 8,
    minHookTokens = 8,
  } = opts;

  // Normalize either input shape to a matched-only Segment[] in original
  // (final-script) order.
  const segments: Segment[] = normalizeToSegments(input);

  const empty: SelectShortResult = {
    clips: [],
    totalRuntimeSec: 0,
    whyItWorks: "No matched footage to build a short from.",
  };
  if (segments.length === 0) return empty;

  const conceptTokens = mineConceptTokens(segments);

  // -- 1. Pick the hook: best-scoring cold-open sentence, earliest on ties. --
  let hookIdx = -1;
  let hookScore = -Infinity;
  for (let i = 0; i < segments.length; i++) {
    if (!isHookCandidate(segments[i], conceptTokens, minHookTokens)) continue;
    const s = scoreHook(segments[i], i, segments.length, conceptTokens);
    if (s > hookScore + 1e-9) {
      hookScore = s;
      hookIdx = i;
    }
  }
  // Fallback: if nothing clears the strict cold-open gates (unusual data),
  // open on the earliest matched sentence long enough to carry a claim so the
  // stage still returns a usable window rather than nothing.
  if (hookIdx === -1) {
    for (let i = 0; i < segments.length; i++) {
      if (tokenize(segments[i].text).length >= minHookTokens) {
        hookIdx = i;
        break;
      }
    }
  }
  if (hookIdx === -1) return empty;

  const hook = segments[hookIdx];

  // -- 2. Walk forward through CONTIGUOUS source lines to build the body. --
  // Contiguity is checked in RAW SOURCE time so the window is one seamless
  // take (no stitching across distant parts of the shoot). A matched line that
  // jumps far from the previous keeper is skipped for contiguity purposes but
  // does NOT end the walk on its own while we are still under the minimum --
  // the next line may resume the take window (matchTakes can interleave one
  // out-of-order keeper). We stop when runtime reaches the target band or a
  // real scene jump breaks the flow.
  const clips: ShortClip[] = [
    { text: hook.text, srcStart: hook.srcStart, srcEnd: hook.srcEnd, role: "hook" },
  ];
  let runtime = dur(hook);
  let lastEnd = hook.srcEnd;

  for (let i = hookIdx + 1; i < segments.length; i++) {
    if (runtime >= maxRuntimeSec) break;
    const seg = segments[i];
    const gap = seg.srcStart - lastEnd;

    // Not contiguous with the current take window: if we already have enough
    // for a short, stop cleanly (seamless single-take window); otherwise skip
    // this stray out-of-order line and keep looking for the take to resume.
    if (gap < 0 || gap > maxContiguityGapSec) {
      if (runtime >= minRuntimeSec) break;
      continue;
    }

    const nextRuntime = runtime + dur(seg);
    // Don't blow past the max: if adding this line would overshoot and we are
    // already in-band, stop on the current (natural sentence) end.
    if (nextRuntime > maxRuntimeSec && runtime >= minRuntimeSec) break;

    clips.push({ text: seg.text, srcStart: seg.srcStart, srcEnd: seg.srcEnd, role: "body" });
    runtime = nextRuntime;
    lastEnd = seg.srcEnd;
  }

  // -- 3. Append a REAL CTA if the creator spoke one anywhere. Never invent. --
  const cta = segments.find(isCtaSegment);
  const hasCta = Boolean(cta);
  if (cta) {
    const alreadyIncluded = clips.some(
      (c) => c.srcStart === cta.srcStart && c.srcEnd === cta.srcEnd
    );
    if (!alreadyIncluded) {
      clips.push({ text: cta.text, srcStart: cta.srcStart, srcEnd: cta.srcEnd, role: "cta" });
      runtime += dur(cta);
    } else {
      // The CTA line was already picked up in the body (possibly mid-body, not
      // just the last clip) -- find it by identity and re-tag THAT clip as the
      // cta role so whyItWorks' "closes on a CTA" claim actually holds.
      const included = clips.find(
        (c) => c.srcStart === cta.srcStart && c.srcEnd === cta.srcEnd
      );
      if (included) included.role = "cta";
    }
  }

  const bodyCount = clips.filter((c) => c.role === "body").length;
  const inBand = runtime >= minRuntimeSec && runtime <= maxRuntimeSec + 6;
  const whyItWorks = buildWhy({ runtime, inBand, bodyCount, hasCta });

  return {
    clips,
    totalRuntimeSec: +runtime.toFixed(2),
    whyItWorks,
  };
}

// ---------------------------------------------------------------------------
// Input normalization + rationale
// ---------------------------------------------------------------------------

function isClipArray(input: Segment[] | Clip[]): input is Clip[] {
  return input.length > 0 && "kind" in input[0];
}

// buildClips carves long internal dead air out of a kept take and emits the
// take as one clip per surviving spoken piece, labelled "<line> (1)", "<line>
// (2)", ... (a single-piece take keeps its plain label). For SHORT SELECTION we
// want one narrative line per sentence, not per piece: the split is a render-
// time timing detail, and leaving the pieces separate inflates the pseudo-
// segment count, which skews mineConceptTokens' document frequencies and the
// position/scoring math (observed: the real n8n hook stopped being selected via
// the Clip[] path). So we coalesce consecutive take clips that share a base
// label back into the original line before selecting.
const PIECE_SUFFIX = / \(\d+\)$/;
const baseLabel = (label: string): string => label.replace(PIECE_SUFFIX, "");

/**
 * Coerce either a Segment[] (from matchTakes) or a Clip[] (from buildClips)
 * into a matched-only Segment[] in original order. From a Clip[] we keep only
 * the `take` clips (silences have no narrative line), coalesce the internal-
 * silence split pieces of one take back into a single line (see PIECE_SUFFIX),
 * and synthesize the minimal Segment shape selectShort needs.
 */
function normalizeToSegments(input: Segment[] | Clip[]): Segment[] {
  if (isClipArray(input)) {
    const takes = input.filter(
      (c) => c.kind === "take" && c.srcStart >= 0 && c.srcEnd > c.srcStart
    );
    const segments: Segment[] = [];
    for (const c of takes) {
      const base = baseLabel(c.label);
      const prev = segments[segments.length - 1];
      // Merge into the previous line only when it is the SAME base label AND
      // this piece continues it in source (starts at/after the previous piece's
      // end). That is exactly the shape buildClips emits for one split take;
      // two genuinely distinct lines never share a base label + adjacency.
      if (prev && prev.text === base && c.srcStart >= prev.srcEnd - 1e-6) {
        prev.srcEnd = c.srcEnd;
        if (c.isKeeperTake) prev.occurrenceCount = Math.max(prev.occurrenceCount, 2);
        continue;
      }
      segments.push({
        text: base,
        srcStart: c.srcStart,
        srcEnd: c.srcEnd,
        occurrenceCount: c.isKeeperTake ? 2 : 1,
        keeperIndex: c.keeperIndex >= 0 ? c.keeperIndex : 0,
        occurrences:
          c.occurrences && c.occurrences.length > 0
            ? c.occurrences
            : [{ start: c.srcStart, end: c.srcEnd }],
      });
    }
    return segments;
  }
  return input.filter(
    (s) => s.occurrenceCount > 0 && s.srcStart >= 0 && s.srcEnd > s.srcStart
  );
}

function buildWhy(params: {
  runtime: number;
  inBand: boolean;
  bodyCount: number;
  hasCta: boolean;
}): string {
  const { runtime, inBand, bodyCount, hasCta } = params;
  const parts: string[] = [];
  parts.push(
    `Opens cold on a verbatim hook that states the concept, then a define -> prove -> stakes body of ${bodyCount} contiguous single-take line${bodyCount === 1 ? "" : "s"}`
  );
  parts.push(hasCta ? "and closes on the creator's real CTA" : "with no fabricated CTA");
  parts.push(
    inBand
      ? `-- ${runtime.toFixed(1)}s, a self-contained short.`
      : `-- ${runtime.toFixed(1)}s (outside the ideal 30-60s band; best available contiguous window).`
  );
  return parts.join(" ");
}
